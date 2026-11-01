import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitepress'

const vuePkgDir = fileURLToPath(new URL('../node_modules/vue', import.meta.url))

// Single source of truth: srcDir points at the repo's existing docs/ folder,
// so every page is rendered in place from the canonical Markdown that is also
// read on GitHub. The site adds no copied content; the only new document is
// docs/index.md (the landing page). Tooling lives in site/ so the published
// package keeps zero runtime dependencies.
export default defineConfig({
  title: 'antiRea',
  description:
    'Evidence-led web anti-cloning toolkit: what each technique can and cannot do, and how to verify it.',
  // Project Pages URL is https://dankezo.github.io/antiRea/ once Pages is on.
  base: '/antiRea/',
  srcDir: '../docs',
  // Raw benchmark evidence stays in the repo and is linked from the QA doc;
  // it is data, not site pages.
  srcExclude: ['evidence/**'],
  // docs/*.md are dual-purpose (GitHub + this site). A few links deliberately
  // point outside the site source (../benchmark/rea/README.md, evidence/*.json)
  // and must keep working on GitHub, so dead-link checking is off here.
  ignoreDeadLinks: true,
  vite: {
    resolve: {
      // Pages live outside this package (srcDir ../docs), so Node module
      // resolution from a page never reaches site/node_modules. Alias 'vue'
      // (imported by every compiled page, e.g. vue/server-renderer) into
      // this package explicitly; dedupe keeps a single Vue copy.
      dedupe: ['vue'],
      alias: [
        {
          find: /^vue\/(.*)$/,
          replacement: `${vuePkgDir}/$1`,
        },
        {
          find: /^vue$/,
          replacement: vuePkgDir,
        },
      ],
    },
  },
  themeConfig: {
    nav: [
      { text: 'Limitations', link: '/LIMITATIONS' },
      { text: 'Threat model', link: '/THREAT_MODEL_REA' },
      { text: 'Server-side controls', link: '/SERVER_SIDE_CONTROLS' },
      { text: 'QA status', link: '/QA_2026-10-31' },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Discover antiRea', link: '/DISCOVERY' },
          { text: 'Limitations and anti-claims', link: '/LIMITATIONS' },
          { text: 'Threat model', link: '/THREAT_MODEL_REA' },
        ],
      },
      {
        text: 'Architecture and controls',
        items: [
          { text: 'Iceberg architecture', link: '/ICEBERG_ARCHITECTURE' },
          { text: 'Server-side controls', link: '/SERVER_SIDE_CONTROLS' },
          { text: 'Privacy and responsible use', link: '/LEGAL_PRIVACY' },
        ],
      },
      {
        text: 'Benchmark and QA',
        items: [
          { text: 'Benchmark protocol', link: '/BENCHMARK_PROTOCOL' },
          { text: 'Twin-SaaS benchmark (v2.1)', link: '/DEMO_BENCHMARK_2_1' },
          { text: 'Reconstruction study (proposed)', link: '/RECONSTRUCTION_STUDY' },
          { text: 'QA and release status', link: '/QA_2026-10-31' },
          { text: 'Security and accuracy audit', link: '/AUDIT_2026-10-31' },
        ],
      },
      {
        text: 'Project',
        items: [
          { text: 'References', link: '/REFERENCES' },
          { text: 'Targets and test boundaries', link: '/TARGETS' },
          { text: 'Launch material', link: '/LAUNCH' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: 'https://github.com/dankezo/antiRea' },
    ],
    search: { provider: 'local' },
    footer: {
      message:
        'antiRea does not make a website unclonable. Claims here are limited to what the linked tests and protocols actually verify.',
      copyright: 'MIT License - Danny Phan',
    },
  },
})
