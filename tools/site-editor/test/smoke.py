#!/usr/bin/env python
"""End-to-end smoke test for site-editor (optional; needs Python Playwright).

It never touches the real `site/` tree: pass the URL of a server started on a *copy*
(--site <tmp>/site) as SITE_EDIT_TMP, and the URL of a read-only server on `site/`
as SITE_EDIT_REAL.

    $env:PYTHONIOENCODING='utf-8'
    & $py -X utf8 tools/site-editor/test/smoke.py

Exits non-zero when a check fails. Screenshots go to %TEMP%\\site-edit-shots.
"""

import os
import pathlib
import sys
import time

from playwright.sync_api import sync_playwright

REAL = os.environ.get("SITE_EDIT_REAL", "http://127.0.0.1:4187/")
TMP = os.environ.get("SITE_EDIT_TMP", "http://127.0.0.1:4188/")
SITE_TMP = pathlib.Path(
    os.environ.get("SITE_EDIT_TMP_DIR", pathlib.Path(os.environ.get("TEMP", "/tmp")) / "site-edit-test" / "site")
)
OUT = pathlib.Path(os.environ.get("SITE_EDIT_SHOTS", pathlib.Path(os.environ.get("TEMP", "/tmp")) / "site-edit-shots"))
OUT.mkdir(parents=True, exist_ok=True)

failures = []
notes = []


def check(name, cond, extra=""):
    if cond:
        print("PASS", name)
    else:
        failures.append(name)
        print("FAIL", name, extra)


def freeze_scroll(page):
    page.add_style_tag(content="html{scroll-behavior:auto !important}")


def find_text(page, needle):
    return page.evaluate(
        """(needle) => {
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let t = w.nextNode();
          while (t) {
            const el = t.parentElement;
            if (el && !el.closest('.se-ui') && t.nodeValue.includes(needle)) {
              el.scrollIntoView({ block: 'center' });
              const r = document.createRange();
              r.selectNodeContents(t);
              const b = r.getBoundingClientRect();
              return { text: t.nodeValue, x: b.x + b.width / 2, y: b.y + b.height / 2 };
            }
            t = w.nextNode();
          }
          return null;
        }""",
        needle,
    )


def find_in_selector(page, selector):
    return page.evaluate(
        """(sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let t = w.nextNode();
          while (t && !t.nodeValue.trim()) t = w.nextNode();
          if (!t) return null;
          const r = document.createRange();
          r.selectNodeContents(t);
          const b = r.getBoundingClientRect();
          return { text: t.nodeValue, x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }""",
        selector,
    )


def click_point(page, rect):
    page.mouse.move(rect["x"], rect["y"])
    time.sleep(0.2)
    page.mouse.click(rect["x"], rect["y"])


def panel_src(page):
    return page.evaluate("document.querySelector('.se-panel-src').textContent")


def panel_msg(page):
    return page.evaluate(
        "document.querySelector('.se-panel-msg') ? document.querySelector('.se-panel-msg').textContent : ''"
    )


def editing_text(page):
    return page.evaluate(
        "document.querySelector('.se-run.is-editing') ? document.querySelector('.se-run.is-editing').textContent : null"
    )


def save_via_enter(page, suffix, wait=0.9):
    page.keyboard.press("End")
    page.keyboard.type(suffix)
    page.keyboard.press("Enter")
    time.sleep(wait)
    return panel_msg(page)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)

    # ------------------------------------------------------------ real site (ro)
    page.goto(REAL, wait_until="load", timeout=30000)
    freeze_scroll(page)
    page.wait_for_timeout(1400)

    runs = page.evaluate(
        """() => {
          const out = [];
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
          let c;
          while ((c = w.nextNode())) {
            const m = /^dsh-e(\\d+)-(\\d+)$/.exec(c.data);
            if (!m) continue;
            const t = c.nextSibling;
            if (!t || t.nodeType !== 3 || !t.nodeValue.trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(t);
            const b = r.getBoundingClientRect();
            out.push({ run: +m[1], line: +m[2], text: t.nodeValue, x: b.x + b.width/2, y: b.y + b.height/2, w: b.width, top: b.top });
          }
          return out;
        }"""
    )
    check("home: editable runs injected", len(runs) > 80, f"got {len(runs)}")
    check("home: toolbar present", page.evaluate("!!document.querySelector('.se-bar')"))
    check("home: token injected", page.evaluate("!!(window.__SITE_EDIT__ && window.__SITE_EDIT__.token)"))
    check("home: no marker leak in text", page.evaluate("!document.body.innerText.includes('dsh-e')"))

    hero = next((r for r in runs if r["w"] > 60 and 120 < r["top"] < 720), None)
    check("home: found a visible run", hero is not None)
    if hero:
        notes.append(f"home run: {hero['text'][:60]!r} line {hero['line']}")
        page.mouse.move(hero["x"], hero["y"])
        page.wait_for_timeout(300)
        check("home: hover outline applied", page.evaluate("!!document.querySelector('.se-run.is-hover')"))
        check("home: status shows source", "index.html" in page.evaluate("document.querySelector('.se-status').textContent"))
        page.screenshot(path=str(OUT / "02-hover.png"))

        page.mouse.click(hero["x"], hero["y"])
        page.wait_for_timeout(300)
        check("home: edit mode entered", page.evaluate("!!document.querySelector('.se-run.is-editing')"))
        check("home: panel visible", page.evaluate("!document.querySelector('.se-panel').hidden"))
        check("home: click does not trim text", editing_text(page) == hero["text"], repr(editing_text(page)))
        page.screenshot(path=str(OUT / "03-edit-panel.png"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        check("home: Esc cancels", page.evaluate("!document.querySelector('.se-run.is-editing')"))

    # ------------------------------------------------------- html write + undo
    page.goto(TMP, wait_until="load", timeout=30000)
    freeze_scroll(page)
    page.wait_for_timeout(1200)
    # take the first card heading from the page instead of hard-coding copy that
    # changes with the site; the test only needs *a* heading in index.html
    needle = page.evaluate("document.querySelector('.card-title').textContent.trim()")
    target = find_text(page, needle)
    check("tmp: found known heading", target is not None)
    if target:
        click_point(page, target)
        page.wait_for_timeout(250)
        check("tmp: edit session started", page.evaluate("!!document.querySelector('.se-run.is-editing')"))
        page.evaluate("window.__survivedSelfWrite = 1")
        save_via_enter(page, "（已改）")
        check("tmp: save toast shown", page.evaluate("!document.querySelector('.se-toast').hidden"), panel_msg(page))
        check("tmp: own save does not reload the tab", page.evaluate("window.__survivedSelfWrite === 1"))
        index_html = (SITE_TMP / "index.html").read_text(encoding="utf-8")
        check("tmp: html file contains edit", (needle + "（已改）") in index_html)
        check("tmp: exactly one occurrence", index_html.count(needle + "（已改）") == 1)
        page.reload(wait_until="load")
        page.wait_for_timeout(900)
        check("tmp: reload keeps edit", page.evaluate("(t) => document.body.innerText.includes(t)", needle + "（已改）"))

        token = page.evaluate("window.__SITE_EDIT__.token")
        status, body = page.evaluate(
            """async (token) => {
              const r = await fetch('/__edit/undo', { method:'POST', headers:{'content-type':'application/json','x-edit-token':token}, body:'{}' });
              return [r.status, await r.text()];
            }""",
            token,
        )
        check("tmp: undo ok", status == 200, body)
        check(
            "tmp: undo restored file",
            "Code understanding（已改）" not in (SITE_TMP / "index.html").read_text(encoding="utf-8"),
        )

    # --------------------------------------------------------------- i18n page
    page.goto(TMP + "architecture/", wait_until="load", timeout=30000)
    freeze_scroll(page)
    page.wait_for_timeout(900)
    crlf_before = (SITE_TMP / "architecture" / "index.html").read_bytes().count(b"\r\n")
    page.click(".lang__btn[data-lang='zh']")
    page.wait_for_timeout(500)
    check("arch: switched to zh", page.evaluate("document.documentElement.lang.toLowerCase().startsWith('zh')"))
    check("arch: chinese rendered", page.evaluate("document.body.innerText.includes('架构')"))

    lead = find_in_selector(page, "section.page-head p.lead")
    check("arch: found lead paragraph", lead is not None)
    if lead:
        click_point(page, lead)
        page.wait_for_timeout(250)
        check("arch: editing paragraph", page.evaluate("!!document.querySelector('.se-run.is-editing')"))
        src = panel_src(page)
        check("arch: source names a dict", "arch.js" in src or "main.js" in src, src)
        save_via_enter(page, "·改", wait=1.8)
        check("arch: arch.js contains edit", "·改" in (SITE_TMP / "assets" / "arch.js").read_text(encoding="utf-8"))
        check("arch: page shows edit after reload", page.evaluate("document.body.innerText.includes('·改')"))
        page.screenshot(path=str(OUT / "05-i18n-saved.png"))

    # multi-run dictionary value (arch.w.assembly: several <span> text runs)
    assembly = find_in_selector(page, ".assembly span.assembly__node")
    if assembly:
        click_point(page, assembly)
        page.wait_for_timeout(250)
        src = panel_src(page)
        check("arch: multi-run value maps to its key", "arch.w.assembly" in src, src)
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

    # table cell rendered from COMPONENTS
    cell = find_in_selector(page, "table.table--components tbody tr:not(.table-group) td:nth-child(2)")
    check("arch: component role cell found", cell is not None)
    if cell:
        click_point(page, cell)
        page.wait_for_timeout(300)
        src = panel_src(page)
        check("arch: table cell maps to COMPONENTS", "COMPONENTS" in src, src)
        save_via_enter(page, "※", wait=1.8)
        check(
            "arch: arch.js got table edit",
            "TIA Portal V17 读写※" in (SITE_TMP / "assets" / "arch.js").read_text(encoding="utf-8"),
        )

    # plain HTML run on the CRLF page
    num = find_in_selector(page, ".card .num")
    if num:
        click_point(page, num)
        page.wait_for_timeout(250)
        src = panel_src(page)
        check("arch: non-dict run maps to html", "architecture/index.html" in src, src)
        page.keyboard.press("End")
        page.keyboard.type("·Z")
        page.keyboard.press("Enter")
        page.wait_for_timeout(800)
        arch_bytes = (SITE_TMP / "architecture" / "index.html").read_bytes()
        check("arch: crlf preserved", arch_bytes.count(b"\r\n") == crlf_before, f"{arch_bytes.count(b'\\r\\n')} vs {crlf_before}")
        check("arch: html edit saved", "·Z".encode("utf-8") in arch_bytes)

    # ----------------------------------------------------- code block + nav link
    page.goto(TMP + "get-started/", wait_until="load", timeout=30000)
    freeze_scroll(page)
    page.wait_for_timeout(900)
    code = find_in_selector(page, "pre.term__body code")
    check("start: code block run found", code is not None)
    if code:
        click_point(page, code)
        page.wait_for_timeout(250)
        check("start: code block editable", page.evaluate("!!document.querySelector('.se-run.is-editing')"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)

    link = page.evaluate(
        """() => {
          const a = document.querySelector('.nav a[href*="roadmap"]');
          if (!a) return null;
          const b = a.getBoundingClientRect();
          return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        }"""
    )
    check("start: nav link present", link is not None)
    if link:
        page.keyboard.down("Control")
        page.mouse.click(link["x"], link["y"])
        page.keyboard.up("Control")
        page.wait_for_timeout(900)
        check("start: Ctrl+click opens link in new tab", len(browser.contexts[0].pages) == 2, f"pages={len(browser.contexts[0].pages)}")
        for extra_page in browser.contexts[0].pages[1:]:
            if "/roadmap/" in extra_page.url:
                extra_page.close()

    # ---------------------------------------------------------------- diff api
    page.goto(REAL, wait_until="load")
    freeze_scroll(page)
    page.wait_for_timeout(1000)
    status, body = page.evaluate(
        """async () => {
          const r = await fetch('/__edit/diff');
          return [r.status, await r.text()];
        }"""
    )
    check("diff endpoint answers", status == 200, body[:120])

    check("no page errors", not errors, "; ".join(errors[:3]))
    serious = [e for e in console_errors if "favicon" not in e.lower() and "net::ERR" not in e]
    check("no console errors", not serious, "; ".join(serious[:3]))
    page.goto(REAL, wait_until="load")
    page.wait_for_timeout(1200)
    page.screenshot(path=str(OUT / "01-overlay.png"))

    print("\nNOTES:")
    for n in notes:
        print(" -", n)
    print("\nRESULT:", "OK" if not failures else f"{len(failures)} FAILURE(S): {failures}")
    browser.close()

sys.exit(0 if not failures else 1)
