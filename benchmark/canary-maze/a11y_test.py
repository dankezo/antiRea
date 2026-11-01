#!/usr/bin/env python3
"""Accessibility benchmark for the Canary Maze bait link (Playwright + axe-core).

Usage: a11y_test.py <base_url> <axe_min_js_path> <out_json>

For the homepage and one maze page:
  - runs axe-core with default rules and records the full violations list
  - asserts zero `aria-hidden-focusable` violations
  - presses Tab 20 times, recording document.activeElement after each press,
    and asserts the bait trap link (href == maze root, text "archive") never
    receives focus; the maze pages' own navigation links are reported
    separately as information, since they are ordinary links by design
  - reads the accessibility tree via CDP Accessibility.getFullAXTree and
    asserts no link node for the trap link ("archive" -> /_canary) is present

This is a Playwright/Chromium measurement of a local test page. It is not
evidence about any real REA tool.
"""

import json
import sys

from playwright.sync_api import sync_playwright

BASE = sys.argv[1].rstrip("/")
AXE_PATH = sys.argv[2]
OUT_JSON = sys.argv[3]
TAB_PRESSES = 20


def flatten_ax_tree(nodes):
    return nodes or []


def check_page(page, label, url):
    page.goto(url, wait_until="load")
    page.add_script_tag(path=AXE_PATH)
    axe = page.evaluate("async () => { const r = await axe.run(); return r; }")
    violations = [
        {
            "id": v["id"],
            "impact": v.get("impact"),
            "nodes": len(v.get("nodes", [])),
            "help": v.get("help"),
        }
        for v in axe.get("violations", [])
    ]
    aria_hidden_focusable = [v for v in violations if v["id"] == "aria-hidden-focusable"]

    # Keyboard: tab through the page, recording the focused element each time.
    page.evaluate("() => { if (document.activeElement) document.activeElement.blur(); window.focus(); }")
    focus_trail = []
    for _ in range(TAB_PRESSES):
        page.keyboard.press("Tab")
        focus_trail.append(
            page.evaluate(
                """() => {
                    const el = document.activeElement;
                    if (!el) return null;
                    return {
                        tag: el.tagName,
                        href: el.getAttribute && el.getAttribute('href'),
                        text: (el.textContent || '').trim().slice(0, 40)
                    };
                }"""
            )
        )
    # The trap link is the bait snippet's anchor specifically: href == the maze
    # root ("/_canary/") and text "archive". The maze pages' own navigation
    # links (href "/_canary/<word>") are ordinary links and are reported
    # separately, not counted as the trap link.
    def is_trap_link(f):
        if not f or not f.get("href"):
            return False
        return f["href"].rstrip("/") == "/_canary" and (f.get("text") or "").strip().lower() == "archive"

    trap_focused = [f for f in focus_trail if is_trap_link(f)]
    focused_maze_nav_links = [
        f["href"] for f in focus_trail if f and f.get("href") and f["href"].startswith("/_canary/") and not is_trap_link(f)
    ]

    # Accessibility tree via CDP.
    cdp = page.context.new_cdp_session(page)
    tree = cdp.send("Accessibility.getFullAXTree")
    nodes = flatten_ax_tree(tree.get("nodes", []))
    tree_links = []
    trap_in_tree = []
    for node in nodes:
        role = (node.get("role") or {}).get("value")
        name = (node.get("name") or {}).get("value", "")
        if role == "link":
            tree_links.append(name)
            if name.strip().lower() == "archive":
                trap_in_tree.append(node)
    # Also try the (deprecated) Playwright accessibility snapshot as a cross-check.
    snapshot_excerpt = None
    try:
        snap = page.accessibility.snapshot()
        snapshot_excerpt = json.dumps(snap)[:2000] if snap else None
    except Exception as exc:  # noqa: BLE001
        snapshot_excerpt = f"unavailable: {exc}"

    return {
        "page": label,
        "url": url,
        "axe_violations": violations,
        "axe_passes_count": len(axe.get("passes", [])),
        "axe_incomplete_count": len(axe.get("incomplete", [])),
        "assert_zero_aria_hidden_focusable": len(aria_hidden_focusable) == 0,
        "focus_trail": focus_trail,
        "focused_maze_nav_links_info": focused_maze_nav_links,
        "assert_trap_link_never_focused": len(trap_focused) == 0,
        "ax_tree_link_names": tree_links,
        "ax_tree_nodes_total": len(nodes),
        "assert_trap_link_absent_from_ax_tree": len(trap_in_tree) == 0,
        "accessibility_snapshot_excerpt": snapshot_excerpt,
    }


def main():
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        results.append(check_page(page, "homepage", BASE + "/"))
        results.append(check_page(page, "maze page", BASE + "/_canary/"))
        browser.close()
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
