#!/usr/bin/env python3
"""Validate the 10 generated site variants. Prints a pass/fail report."""
import pathlib, re

OUT = pathlib.Path.home() / "axon-site" / "versions"
ACCENTS = {1:"3df2ff",2:"34e0a0",3:"ff4d6d",4:"a78bfa",5:"ffc24b",
           6:"8ad7ff",7:"ff5cf0",8:"ff8c42",9:"2dd4bf",10:"e8eef5"}

def check(i):
    f = OUT / f"v{i}.html"
    if not f.exists(): return None, ["FILE MISSING"]
    t = f.read_text(); acc = ACCENTS[i]
    checks = {
        "size > 30KB":        len(t) > 30000,
        "7 <section> blocks": t.count("<section") == 7,
        "hero present":       'id="hero"' in t,
        "waitlist modal":     'id="wlModal"' in t,
        "waitlist wired":     "formsubmit.co" in t and "JOIN THE WAITLIST" in t,
        "three.js importmap": "three@0.161" in t,
        "3 models built":     all(x in t for x in ("buildBrain","buildHelmet","buildArray")),
        "accent applied":     ("#"+acc) in t and ("0x"+acc) in t,
        "no leftover cyan":   "#3df2ff" not in t or i==1,
        "<style> balanced":   t.count("<style") == t.count("</style>"),
        "<script> balanced":  t.count("<script") == t.count("</script>"),
        "{ } balanced":       t.count("{") == t.count("}"),
        "closes </html>":     t.rstrip().endswith("</html>"),
    }
    fails = [k for k,v in checks.items() if not v]
    return checks, fails

print(f"{'VER':<5}{'STATUS':<8}{'CHECKS':<10}NOTES")
print("-"*60)
allok = True
for i in range(1,11):
    checks, fails = check(i)
    if checks is None:
        print(f"v{i:<4}{'MISSING':<8}"); allok=False; continue
    passed = sum(checks.values())
    status = "PASS" if not fails else "FAIL"
    if fails: allok = False
    print(f"v{i:<4}{status:<8}{passed}/{len(checks):<8}{'' if not fails else ', '.join(fails)}")
print("-"*60)
print("ALL VERSIONS PASS ✓" if allok else "Some checks failed — see notes")
