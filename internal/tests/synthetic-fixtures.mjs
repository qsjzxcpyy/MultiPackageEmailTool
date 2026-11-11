import fs from 'node:fs/promises';
import path from 'node:path';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';

// The old August 31 desktop exports are absent. Keep the 86/76 regression
// self-contained using fictional orders and recipients, with the same capacity.
export async function createCurrentFixtures(directory) {
  const cloud = Workbook.create();
  const erp = Workbook.create();
  const cloudRows = [['Shipment ID','Carrier','Tracking Number','Seller','Ship From']];
  const erpRows = [['refrence_no','consignee_email']];
  for (let n = 1; n <= 86; n++) {
    const order = `111-0000000-${String(n).padStart(7,'0')}`;
    cloudRows.push([order,'Fedex',`878000${String(n).padStart(6,'0')}`,'Synthetic','DEMOD_US']);
    cloudRows.push([order,'UPS',`1ZTEST${String(n).padStart(12,'0')}`,'Synthetic','DEMOD_US']);
    if (n <= 76) erpRows.push([order,`synthetic${n}@example.com`]);
  }
  cloud.worksheets.add('Shipment').getRange(`A1:E${cloudRows.length}`).values = cloudRows;
  erp.worksheets.add('Export orders').getRange(`A1:B${erpRows.length}`).values = erpRows;
  const source = path.join(directory,'synthetic-cloud.xlsx');
  const erpPath = path.join(directory,'synthetic-erp.xlsx');
  await fs.writeFile(source,(await SpreadsheetFile.exportXlsx(cloud)).data);
  await fs.writeFile(erpPath,(await SpreadsheetFile.exportXlsx(erp)).data);
  return {source,erp:erpPath};
}
