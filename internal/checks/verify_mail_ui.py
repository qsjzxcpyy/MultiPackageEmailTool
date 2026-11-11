"""Acceptance for requested UI corrections; isolated fake transport only."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT=Path(sys.argv[1]).resolve()
FIXTURES=ROOT
BASE='http://127.0.0.1:18789'
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(viewport={'width':1440,'height':1000},permissions=['clipboard-read','clipboard-write'])
    page=context.new_page()
    errors=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    page.route('**/*',lambda route:route.continue_() if route.request.url.startswith(BASE+'/') else route.abort())
    page.goto(BASE)
    page.wait_for_load_state('networkidle')
    expect(page.locator('#mail-auth-name')).to_have_text('默认授权码已选中')
    expect(page.locator('#mail-auth-description')).to_contain_text('fake-authorization.txt')
    assert page.locator('#mail-batch-select').count()==0
    assert '发送批次' not in page.locator('#mail-stage').inner_text()
    page.locator('#cloud-file').set_input_files(str(FIXTURES/'synthetic-cloud.xlsx'))
    page.locator('#cloud-upload-button').click()
    expect(page.locator('#cloud-state')).to_have_text('已完成',timeout=30000)
    page.locator('#cloud-list-toggle-button').click()
    expect(page.locator('#cloud-table-wrap')).to_be_hidden()
    page.locator('#mail-list-toggle-button').click()
    expect(page.locator('#mail-table-wrap')).to_be_hidden()
    page.locator('#erp-file').set_input_files(str(FIXTURES/'synthetic-erp.xlsx'))
    page.locator('#erp-upload-button').click()
    expect(page.locator('#result-state')).to_have_text('已生成',timeout=30000)
    expect(page.locator('#cloud-table-wrap')).to_be_hidden()
    expect(page.locator('#cloud-list-toggle-button')).to_have_attribute('aria-expanded','false')
    expect(page.locator('#mail-table-wrap')).to_be_hidden()
    expect(page.locator('#mail-send-button')).to_be_enabled()
    expect(page.locator('#review-tab-count')).to_have_text('1')
    assert page.locator('#mail-records tr[data-key]').count()==0
    # Uploading ERP must not jump/scroll the viewport down to the sending panel.
    assert page.locator('#mail-stage').bounding_box()['y'] > 100, 'ERP matching forcibly jumped to sending panel'
    page.locator('#result-list-toggle-button').click()
    expect(page.locator('#result-table-wrap')).to_be_hidden()
    # Default credentials need no user file selection. Upload replacement solely
    # to verify persistence, then reload before ever clicking send.
    replacement=FIXTURES/'replacement-fake.txt'
    replacement.write_text('demod@example.invalid----FICTIONAL-SAVED-CODE',encoding='utf-8')
    page.locator('#mail-auth-file').set_input_files(str(replacement))
    expect(page.locator('#mail-message')).to_contain_text('授权码已保存')
    page.reload()
    expect(page.locator('#mail-auth-description')).to_contain_text('replacement-fake.txt')
    expect(page.locator('#mail-count-total')).to_have_text('0')
    expect(page.locator('#mail-send-button')).to_be_disabled()
    page.locator('#cloud-file').set_input_files(str(FIXTURES/'synthetic-cloud.xlsx'))
    page.locator('#cloud-upload-button').click()
    expect(page.locator('#cloud-state')).to_have_text('已完成',timeout=30000)
    page.locator('#erp-file').set_input_files(str(FIXTURES/'synthetic-erp.xlsx'))
    page.locator('#erp-upload-button').click()
    expect(page.locator('#result-state')).to_have_text('已生成',timeout=30000)
    expect(page.locator('#mail-send-button')).to_be_enabled()
    expect(page.locator('#mail-table-wrap')).to_be_hidden()
    page.locator('#mail-list-toggle-button').click()
    expect(page.locator('#mail-table-wrap')).to_be_visible()
    assert page.locator('#mail-records tr[data-key]').count()==0
    page.evaluate('window.rowAnimations=[];document.addEventListener("animationstart",event=>{if(event.animationName==="mail-row-arrive")window.rowAnimations.push(event.target.dataset.key)})')
    page.locator('#mail-send-button').click()
    expect(page.locator('#mail-phase')).to_have_text('发送中')
    expect(page.locator('#mail-send-button')).to_be_disabled()
    feed=page.locator('#mail-records tr[data-key]')
    expect(feed).to_have_count(1,timeout=10000)
    expect(page.locator('.delivery-sending')).to_have_count(1)
    page.wait_for_function('window.rowAnimations.length>=1')
    page.evaluate('window.firstMailRow=document.querySelector("#mail-records tr[data-key]")')
    # Fold while sending. Updates must never force it open.
    page.locator('#mail-list-toggle-button').click()
    expect(feed).to_have_count(2,timeout=10000)
    expect(page.locator('#mail-table-wrap')).to_be_hidden()
    assert page.evaluate('window.firstMailRow===document.querySelector("#mail-records tr[data-key]")')
    page.locator('#mail-list-toggle-button').click()
    page.locator('#mail-records summary').first.click()
    page.evaluate('window.firstMailDetails=document.querySelector("#mail-records details");window.sourceOption=document.querySelector("#mail-source-filter option:last-child")')
    expect(page.locator('#mail-phase')).to_have_text('本轮已结束',timeout=20000)
    expect(feed).to_have_count(3)
    assert page.evaluate('window.firstMailDetails===document.querySelector("#mail-records details") && window.firstMailDetails.open')
    assert page.evaluate('window.sourceOption===document.querySelector("#mail-source-filter option:last-child")')
    for key in ['sent','failed','uncertain']:
        expect(page.locator('#mail-count-'+key)).to_have_text('1')
        expect(page.locator('.delivery-'+key)).to_have_count(1)
    # No unchanged polling may replace table nodes or close expanded content.
    page.evaluate('window.pollMutations=0;window.pollObserver=new MutationObserver(ms=>window.pollMutations+=ms.filter(m=>m.type==="childList").length);window.pollObserver.observe(document.querySelector("#mail-records"),{childList:true,subtree:true})')
    page.wait_for_timeout(5600)
    assert page.evaluate('window.pollMutations')==0
    assert page.evaluate('window.firstMailDetails.open')
    page.locator('#mail-status-filter').select_option('failed')
    expect(page.locator('#mail-records tr[data-key]:visible')).to_have_count(1)
    expect(page.locator('#mail-records tr[data-key]:visible')).to_contain_text('0000002')
    page.locator('#mail-status-filter').select_option('unsuccessful')
    expect(page.locator('#mail-records tr[data-key]:visible')).to_have_count(2)
    page.locator('#mail-status-filter').select_option('')
    page.locator('#mail-search').fill('111-0000000-0000001')
    expect(page.locator('#mail-records tr[data-key]:visible')).to_have_count(1)
    row=page.locator('#mail-records tr[data-key]:visible')
    body=row.locator('pre').inner_text()
    row.locator('.mail-copy').click()
    expect(page.locator('#mail-message')).to_contain_text('已复制订单')
    assert page.evaluate('navigator.clipboard.readText()').replace('\r\n','\n')==body.replace('\r\n','\n')
    page.locator('#mail-search').fill('')
    # Same statistics sizing and header/table classes as the aggregation area.
    assert page.locator('#mail-stats .stat-card').count()==4
    button_boxes=[page.locator(selector).bounding_box() for selector in ['#mail-auth-change','#mail-send-button']]
    assert abs(button_boxes[0]['y']-button_boxes[1]['y'])<=1
    assert abs(button_boxes[0]['height']-button_boxes[1]['height'])<=1
    page.locator('#mail-stage').screenshot(path=str(ROOT/'mail-v2-desktop.png'))
    page.locator('#mail-list-toggle-button').click()
    page.reload()
    expect(page.locator('#mail-phase')).to_have_text('等待生成邮件',timeout=10000)
    expect(page.locator('#mail-count-total')).to_have_text('0')
    expect(page.locator('#mail-table-wrap')).to_be_hidden()
    expect(page.locator('#mail-auth-description')).to_contain_text('replacement-fake.txt')
    page.locator('#mail-list-toggle-button').click()
    page.locator('#cloud-file').set_input_files(str(FIXTURES/'synthetic-cloud.xlsx'))
    page.locator('#cloud-upload-button').click()
    expect(page.locator('#cloud-state')).to_have_text('已完成',timeout=30000)
    expect(page.locator('#cloud-table-wrap')).to_be_hidden()
    page.locator('#erp-file').set_input_files(str(FIXTURES/'synthetic-erp.xlsx'))
    page.locator('#erp-upload-button').click()
    expect(page.locator('#result-state')).to_have_text('已生成',timeout=30000)
    expect(page.locator('#mail-phase')).to_have_text('本轮已结束')
    expect(page.locator('#mail-count-sent')).to_have_text('1')
    expect(page.locator('#cloud-table-wrap')).to_be_hidden()
    expect(page.locator('#result-table-wrap')).to_be_hidden()
    page.locator('#mail-records summary').first.click()
    page.set_viewport_size({'width':390,'height':844})
    page.locator('#mail-stage').screenshot(path=str(ROOT/'mail-v2-mobile.png'))
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
    context=browser.new_context(viewport={'width':1440,'height':900},reduced_motion='reduce')
    reduced=context.new_page()
    reduced.goto(BASE)
    expect(reduced.locator('#mail-phase')).to_have_text('等待生成邮件')
    assert float(reduced.evaluate('''() => {const el=document.createElement('div');el.className='mail-row-enter';document.body.append(el);const duration=parseFloat(getComputedStyle(el).animationDuration);el.remove();return duration;}'''))<0.01
    assert not errors,errors
    browser.close()
    report=dict(ok=True,real_emails_sent=0,transport='injected fake only',aggregation_collapse_preserved=True,result_collapse_preserved=True,no_batch_selector=True,stable_poll_nodes=True,incremental_row_counts=[1,2,3],default_authorization=True,replacement_persisted=True,buttons_aligned=True,sending_collapse=True,search=True,copy=True,reload=True,reduced_motion=True,page_errors=errors)
    (ROOT/'web_v2_verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print('V2 browser checks passed; no real emails sent')
