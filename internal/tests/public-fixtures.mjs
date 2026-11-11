// These fixtures are entirely synthetic and are created in a unique temp folder.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

async function workbook(filename,sheet,rows) {
  const wb=Workbook.create();
  const last=String.fromCharCode(64+rows[0].length);
  wb.worksheets.add(sheet).getRange(`A1:${last}${rows.length}`).values=rows;
  await fs.writeFile(filename,(await SpreadsheetFile.exportXlsx(wb)).data);
  return filename;
}
export async function createLegacyFixtures() {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'public-mail-fixtures-'));
  after(()=>fs.rm(root,{recursive:true,force:true}));
  const headers=['Shipment ID','Carrier','Tracking Number','Seller','Ship From'];
  const rows=[headers];
  // 55 two-package and 24 three-package orders (182 tracking numbers).
  for (let n=0;n<79;n++) {
    const order=['112-0000000-0000016','114-0000000-0000022'][n] || `111-0000000-${String(100+n).padStart(7,'0')}`;
    for (let k=0;k<(n<55?2:3);k++) rows.push([order,'Fedex',`990${String(n*3+k).padStart(9,'0')}`,'Synthetic','DEMOC_US']);
  }
  const cloud=await workbook(path.join(root,'legacy-cloud.xlsx'),'Shipment',rows);
  const unmatchedErp=await workbook(path.join(root,'unmatched-erp.xlsx'),'Export orders',[
    ['refrence_no','consignee_email'],['UNRELATED-ORDER','nobody@example.invalid']]);
  const mixedRows=[headers], buyers=[['refrence_no','consignee_email']];
  for (let n=0;n<27;n++) {
    const order=n===0?'111-0000000-0000006':`111-0000000-${String(300+n).padStart(7,'0')}`;
    mixedRows.push([order,'Fedex',n===0?'990000000013':`991${String(n).padStart(9,'0')}`,'Synthetic','DEMOB_US']);
    mixedRows.push([order,'UPS',n===0?'1Z9900000000000004':`1ZTEST${String(n).padStart(12,'0')}`,'Synthetic','DEMOB_US']);
    buyers.push([order,n===0?'demo-recipient@marketplace.amazon.com':`buyer${n}@example.invalid`]);
  }
  const mixedCloud=await workbook(path.join(root,'mixed-cloud.xlsx'),'Shipment',mixedRows);
  const mixedErp=await workbook(path.join(root,'mixed-erp.xlsx'),'Export orders',buyers);
  return {cloud,unmatchedErp,mixedCloud,mixedErp};
}
