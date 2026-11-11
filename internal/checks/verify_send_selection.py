"""Fake HTTP only: a Send click must stay bound to the data the user saw."""
import asyncio
from playwright.async_api import async_playwright, expect

BASE='http://127.0.0.1:18789'

async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True)
        page=await browser.new_page()
        await page.route('**/app.js',lambda r:r.fulfill(body='',content_type='text/javascript'))
        await page.goto(BASE)
        await page.evaluate('''async () => {
          window.posts=[];
          window.pauseSession=false; window.pauseSend=false;
          window.fetch=async (url, options={}) => {
            if (url==='/api/mail/credentials') return Response.json({ready:true,filename:'fake.txt',senderCount:1});
            if (url==='/api/mail/batches') return Response.json({batches:[]});
            if (url==='/api/mail/session') {
              if (window.pauseSession) await new Promise(resolve=>window.releaseSession=resolve);
              return Response.json({token:'fictional-token'});
            }
            if (url.endsWith('/send')) {
              window.posts.push(url);
              if (window.pauseSend) await new Promise(resolve=>window.releaseSend=resolve);
              return Response.json({...window.first,phase:'running'});
            }
            throw Error('Unexpected request in offline test');
          };
          const {mountMailPanel}=await import('/mail.js');
          window.panel=mountMailPanel();
          const job=(id,total)=>({id,phase:'ready',counts:{total,pending:total,sending:0,sent:0,failed:0,uncertain:0},records:[]});
          window.first=job('a'.repeat(64),1);window.second=job('b'.repeat(64),2);
        }''')
        await expect(page.locator('#mail-auth-name')).to_have_text('默认授权码已选中')
        await page.evaluate('window.panel.setData(window.first);window.pauseSession=true')
        await page.locator('#mail-send-button').click()
        await page.wait_for_function("typeof window.releaseSession === 'function'")
        await page.evaluate('window.panel.setData(window.second);window.releaseSession()')
        await expect(page.locator('#mail-send-button')).to_be_enabled()
        assert await page.evaluate('window.posts')==[], 'An outdated click sent different data'
        await expect(page.locator('#mail-count-total')).to_have_text('2')
        await page.evaluate('window.pauseSession=false;window.pauseSend=true;window.panel.setData(window.first)')
        await page.locator('#mail-send-button').click()
        await page.wait_for_function("typeof window.releaseSend === 'function'")
        await page.evaluate('window.panel.setData(window.second);window.releaseSend()')
        await expect(page.locator('#mail-send-button')).to_be_enabled()
        await expect(page.locator('#mail-count-total')).to_have_text('2')
        assert await page.evaluate('window.posts')==['/api/mail/batches/'+'a'*64+'/send']
        await browser.close()
        print('Offline send-selection checks passed; zero real emails')

asyncio.run(main())
