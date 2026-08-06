# -*- coding: utf-8 -*-
"""
demo-app 场景验证脚本

用途：
  启动 demo-app（pnpm --filter @xapiforge/example-demo-app dev）
  + mock-server（pnpm mock）后，跑此脚本自动验证所有场景。
  作为库改动的回归测试：失败场景数 > 0 时 exit code = 1。

依赖：
  pip install playwright && playwright install chromium

运行：
  python3 scripts/test/demo-app-scenarios.py

策略：
  1. 直接往 localStorage 注入 mock-token 绕过登录
  2. 导航到 /scenarios
  3. 点 "▶ Run All" 按钮
  4. 轮询 summary 直到所有场景跑完
  5. 从 DOM 抓取所有场景结果
"""

from playwright.sync_api import sync_playwright
import re
import sys
import time

# demo-app 默认端口 5173（见 examples/demo-app/vite.config.ts）
URL = "http://localhost:5173/scenarios"


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context()
        page = ctx.new_page()

        # 收集 console 日志
        console_logs = []
        page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
        page.on("pageerror", lambda err: console_logs.append(f"[PAGEERROR] {err}"))

        print(f"→ 打开 {URL}")
        page.goto(URL, wait_until="domcontentloaded", timeout=15000)

        # 先注入 token（绕过路由守卫）
        page.evaluate("""
            () => {
                localStorage.setItem('app_token', 'mock-token');
                localStorage.setItem('app_refresh_token', 'mock-refresh-token');
            }
        """)

        # 重新加载（让路由守卫看到 token）
        page.goto(URL, wait_until="domcontentloaded", timeout=15000)
        time.sleep(1)
        page.wait_for_load_state("networkidle", timeout=10000)
        print(f"→ 当前 URL: {page.url}")

        # 确认在 Scenarios 页
        if page.url.rstrip("/") != URL:
            print(f"⚠ URL 不对: {page.url}，尝试导航到 /")
            page.goto(URL, wait_until="domcontentloaded", timeout=15000)
            time.sleep(1)

        # 找 Run All 按钮
        run_all = page.locator("button.btn-run-all")
        if run_all.count() == 0:
            # fallback: 找包含 "Run All" 的按钮
            run_all = page.locator("button", has_text="Run All").first

        if run_all.count() == 0:
            print("✗ 找不到 Run All 按钮")
            buttons = page.locator("button").all()
            for i, b in enumerate(buttons):
                print(f"  button[{i}]: '{b.text_content()}'")
            browser.close()
            sys.exit(1)

        # 确认场景数
        scenario_rows = page.locator(".scenario-row").count()
        print(f"→ 找到 {scenario_rows} 个 scenario-row")

        print("→ 点击 ▶ Run All")
        run_all.click()

        # 轮询 summary，等所有场景跑完
        print("→ 等待场景跑完...")
        max_wait = 180
        waited = 0
        final_summary = None
        while waited < max_wait:
            time.sleep(3)
            waited += 3

            # 用 evaluate 直接读（避免 locator 超时）
            state = page.evaluate("""
                () => {
                    const bar = document.querySelector('.summary-bar');
                    const summaryText = bar ? bar.textContent : '';
                    const running = document.querySelectorAll('.running-indicator').length;
                    const btn = document.querySelector('.btn-run-all');
                    const btnText = btn ? btn.textContent : '';
                    return { summaryText, running, btnText };
                }
            """)

            summary_text = state.get("summaryText", "")
            m = re.search(r"总计\s*(\d+).*?通过\s*(\d+).*?失败\s*(\d+)", summary_text, re.S)
            if m:
                total = int(m.group(1))
                passed = int(m.group(2))
                failed = int(m.group(3))
                print(f"  [{waited}s] 总计 {total}, 通过 {passed}, 失败 {failed}, running={state['running']}, btn='{state['btnText'][:30]}'")

                # 判断是否跑完：running 状态消失 + 按钮恢复
                if state["running"] == 0 and "运行中" not in state["btnText"] and total > 0:
                    time.sleep(1)
                    state2 = page.evaluate("""
                        () => {
                            return {
                                running: document.querySelectorAll('.running-indicator').length,
                                btnText: (document.querySelector('.btn-run-all') || {}).textContent || ''
                            };
                        }
                    """)
                    if state2["running"] == 0 and "运行中" not in state2["btnText"]:
                        final_summary = (total, passed, failed)
                        print(f"  [{waited}s] 跑完了!")
                        break
            else:
                print(f"  [{waited}s] summary 未找到, running={state['running']}")

        # 抓取所有场景结果
        results = page.evaluate("""
            () => {
                const rows = document.querySelectorAll('.scenario-row');
                const out = [];
                rows.forEach(row => {
                    const nameEl = row.querySelector('.scenario-name');
                    const badgeEl = row.querySelector('.badge');
                    const expectedEl = row.querySelector('.expected');
                    const actualEl = row.querySelector('.actual');
                    const timingEl = row.querySelector('.timing');
                    const status = row.className.includes('done') ? 'done' : 'pending';
                    const pass = badgeEl ? badgeEl.textContent.includes('PASS') : null;
                    out.push({
                        name: nameEl ? nameEl.textContent.trim() : '?',
                        pass: pass,
                        expected: expectedEl ? expectedEl.textContent.trim() : '',
                        actual: actualEl ? actualEl.textContent.trim() : '',
                        timing: timingEl ? timingEl.textContent.trim() : '',
                        status: status
                    });
                });
                return out;
            }
        """)

        print("\n" + "=" * 80)
        print("场景验证结果")
        print("=" * 80)

        if final_summary:
            print(f"\n汇总: 总计 {final_summary[0]}, ✓ 通过 {final_summary[1]}, ✗ 失败 {final_summary[2]}")
        else:
            print("\n⚠ 未能确认所有场景跑完")

        done_results = [r for r in results if r["status"] == "done"]
        pending_results = [r for r in results if r["status"] != "done"]
        passed_results = [r for r in done_results if r["pass"]]
        failed_results = [r for r in done_results if r["pass"] is False]

        print(f"已跑完: {len(done_results)}, 通过: {len(passed_results)}, 失败: {len(failed_results)}, 未跑: {len(pending_results)}")

        if failed_results:
            print(f"\n{'─' * 80}")
            print(f"失败场景详情 ({len(failed_results)} 个):")
            print("─" * 80)
            for r in failed_results:
                print(f"\n✗ {r['name']}  ({r['timing']})")
                print(f"  预期: {r['expected']}")
                print(f"  实际: {r['actual']}")

        if pending_results:
            print(f"\n{'─' * 80}")
            print(f"未跑完的场景 ({len(pending_results)} 个):")
            print("─" * 80)
            for r in pending_results:
                print(f"  - {r['name']}")

        # 输出失败的 console error（测试场景会故意触发 401/429/500，这些是预期错误）
        errors = [l for l in console_logs if l.startswith("[PAGEERROR]")]
        if errors:
            print(f"\n{'─' * 80}")
            print(f"页面异常 ({len(errors)} 条，非预期):")
            print("─" * 80)
            for e in errors[:30]:
                print(f"  {e[:300]}")

        browser.close()

        # exit code: 失败场景数 > 0 时返非零（CI 用）
        if failed_results:
            sys.exit(1)


if __name__ == "__main__":
    main()
