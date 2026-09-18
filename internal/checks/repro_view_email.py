import os
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[3]
CLOUD_FILE = Path(r"C:\Users\Administrator.DESKTOP-OV0JDHK\Desktop\多包裹\8月26推单多包裹\Drop Shipping Order List20260826232408.xlsx")
ERP_FILE = Path(r"C:\Users\Administrator.DESKTOP-OV0JDHK\Desktop\多包裹\8月26推单多包裹\order-1787822395.xlsx")
BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:8788")


def main():
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        )
        page = browser.new_page()
        console_messages = []
        page.on("console", lambda message: console_messages.append(f"{message.type}: {message.text}"))
        page.on("pageerror", lambda error: console_messages.append(f"pageerror: {error}"))

        page.goto(BASE_URL, wait_until="networkidle")
        page.locator("#cloud-file").set_input_files(str(CLOUD_FILE))
        page.locator("#cloud-upload-button").click()
        page.locator("#cloud-output").wait_for(state="visible")

        cloud_rows = [
            row.locator("td").all_text_contents()
            for row in page.locator("#cloud-table-wrap tbody tr").all()
        ]
        cloud_source_options = page.locator("#cloud-source-filter option").all_text_contents()
        expected_zeiinpa_orders = [row[0] for row in cloud_rows if len(row) > 1 and row[1] == "ZEIINPA_US"]
        page.locator("#cloud-source-filter").select_option("ZEIINPA_US")
        filtered_cloud_rows = [
            row.locator("td").all_text_contents()
            for row in page.locator("#cloud-table-wrap tbody tr").all()
        ]
        assert cloud_source_options == [
            "全部来源", "ZEIINPA_US", "VYNELITO_US", "XOCN_US", "THRYVIX_US_US",
        ]
        assert [row[0] for row in filtered_cloud_rows] == expected_zeiinpa_orders
        assert len(filtered_cloud_rows) == 8
        assert all(row[1] == "ZEIINPA_US" for row in filtered_cloud_rows)

        page.locator("#cloud-source-filter").select_option("")
        first_row = page.locator("#cloud-table-wrap tbody tr").first
        cells_before = first_row.locator("td").all_text_contents()
        details = first_row.locator("details")
        summary = details.locator("summary")
        summary.click()
        expanded = details.get_attribute("open")
        email_body = details.locator("pre").inner_text()

        page.locator("#erp-file").set_input_files([str(ERP_FILE), str(ERP_FILE)])
        assert "2 个文件" in page.locator("#erp-file-name").inner_text()
        assert page.locator("#erp-upload-button").is_enabled()
        page.locator("#erp-upload-button").click()
        page.locator("#result-output").wait_for(state="visible")
        result_rows = []
        for row in page.locator("#result-table-wrap tbody tr").all():
            result_rows.append(row.locator("td").all_text_contents())
        thryvix_rows = [row for row in result_rows if "17322503251@163.com" in "\n".join(row)]
        source_values = sorted({row[1] for row in result_rows if len(row) > 1})
        sender_values = sorted({row[-1] for row in result_rows if row})
        result_details = page.locator("#result-table-wrap details").first
        result_details.locator("summary").click()
        result_email_open_after_click = result_details.get_attribute("open")
        page.locator("#result-source-filter").select_option("THRYVIX_US_US")
        filtered_result_rows = [
            row.locator("td").all_text_contents()
            for row in page.locator("#result-table-wrap tbody tr").all()
        ]
        page.screenshot(
            path=str(ROOT / "MultiPackageEmailTool" / "internal" / "checks" / "latest-result-preview.png"),
            full_page=True,
        )

        assert len(result_rows) == 25
        assert source_values == ["THRYVIX_US_US", "VYNELITO_US", "XOCN_US", "ZEIINPA_US"]
        assert sender_values == [
            "13288070760@163.com",
            "15889560452@163.com",
            "17322503251@163.com",
            "3777612514@qq.com",
        ]
        assert thryvix_rows and all(row[1] == "THRYVIX_US_US" for row in thryvix_rows)
        assert thryvix_rows and all(row[-1] == "17322503251@163.com" for row in thryvix_rows)
        assert expanded == ""
        assert result_email_open_after_click == ""
        assert page.locator("#result-source-filter option").all_text_contents() == [
            "全部来源", "ZEIINPA_US", "VYNELITO_US", "XOCN_US", "THRYVIX_US_US",
        ]
        assert len(filtered_result_rows) == 3
        assert all(row[1] == "THRYVIX_US_US" for row in filtered_result_rows)
        assert all(row[-1] == "17322503251@163.com" for row in filtered_result_rows)

        print({
            "rows": page.locator("#cloud-table-wrap tbody tr").count(),
            "cloud_filtered_rows": len(filtered_cloud_rows),
            "first_row_cells": cells_before,
            "details_open_after_click": expanded,
            "email_body_preview": email_body[:120],
            "result_rows": len(result_rows),
            "result_filtered_rows": len(filtered_result_rows),
            "result_first_row": result_rows[0] if result_rows else [],
            "result_last_row": result_rows[-1] if result_rows else [],
            "source_values": source_values,
            "sender_values": sender_values,
            "thryvix_rows": thryvix_rows,
            "result_email_open_after_click": result_email_open_after_click,
            "console": console_messages,
        })
        browser.close()


if __name__ == "__main__":
    main()
