#!/usr/bin/env python3
"""Legacy filename retained so older links do not silently yield incorrect attribution.

The former hidden 128-pixel decoder relied on an alpha-blended 2-pixel strip and
was not reliable after screenshots, scaling, or video compression. v2.0 beta uses a
visible, opaque watermark token for manual evidence review. This tool deliberately
refuses to guess a user identity from pixels.
"""
import sys
print("antiRea v2.0 beta: automatic steganographic decoding has been retired. ")
print("Read the visible opaque token in a screenshot, then resolve it in your private, access-controlled audit ledger.")
sys.exit(2)
