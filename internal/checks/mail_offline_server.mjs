// Isolated browser verification. There is deliberately no SMTP implementation
// or executable launch here. All inputs and results are synthetic.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import { createApp } from '../../server.mjs';
import { writeMailSnapshot } from '../../mail_jobs.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'mail-browser-offline-'));
const fixtureDir = path.resolve(process.argv[2]);
await fs.mkdir(fixtureDir,{recursive:true});
const cloud = Workbook.create();
const erp = Workbook.create();
const shipments = [['Shipment ID','Carrier','Tracking Number','Seller','Ship From']];
const buyers = [['refrence_no','consignee_email']];
for (let n=1;n<=4;n++) {
  const order = `111-0000000-${String(n).padStart(7,'0')}`;
  shipments.push([order,'Fedex',`87800000000${n}`,'Synthetic','DEMOD_US']);
  shipments.push([order,'UPS',`1ZTEST00000000000${n}`,'Synthetic','DEMOD_US']);
  if (n<=3) buyers.push([order,`synthetic${n}@example.com`]);
}
cloud.worksheets.add('Shipment').getRange(`A1:E${shipments.length}`).values=shipments;
erp.worksheets.add('Export orders').getRange(`A1:B${buyers.length}`).values=buyers;
await fs.writeFile(path.join(fixtureDir,'synthetic-cloud.xlsx'),(await SpreadsheetFile.exportXlsx(cloud)).data);
await fs.writeFile(path.join(fixtureDir,'synthetic-erp.xlsx'),(await SpreadsheetFile.exportXlsx(erp)).data);
await fs.writeFile(path.join(fixtureDir,'fake-authorization.txt'),'demod@example.invalid----FICTIONAL-NOT-A-REAL-CODE');
const server=createApp({rootDir,tempDir:temporary,mailDataDir:path.join(temporary,'history'),
  mailCredentialsDir:path.join(temporary,'settings'),defaultCredentialFiles:[path.join(fixtureDir,'fake-authorization.txt')],launchWorker:async input=>{
  const metadata=JSON.parse(await fs.readFile(path.join(path.dirname(input.manifestPath),'batch.json'),'utf8'));
  if (!metadata.rows.every(row=>row.收件邮箱.endsWith('@example.com'))) throw new Error('Only fictional data allowed');
  await fs.copyFile(input.workbook,path.join(fixtureDir,'synthetic-final.xlsx'));
  await fs.writeFile(path.join(fixtureDir,'expected-rows.json'),JSON.stringify(input.expectedRows));
  const records=metadata.rows.map((row,index)=>({row:index+2,status:'pending',attempts:0,detail:'离线模拟，未连接邮箱'}));
  async function progress(phase) {
    await writeMailSnapshot(input.progressPath,{phase,records});
  }
  for(let index=0;index<records.length;index++) {
    records[index]={...records[index],status:'sending',attempts:1,detail:'离线模拟处理中'};
    await progress('running');
    await new Promise(resolve=>setTimeout(resolve,1800));
    records[index]={...records[index],status:['sent','failed','uncertain'][index],detail:['模拟：服务器已接收','模拟：SMTP 拒绝，状态码 550','模拟：提交后连接中断，请核对'][index]};
    await progress('running');
  }
  await progress('completed');
}});
server.listen(18789,'127.0.0.1',()=>console.log('OFFLINE FAKE WORKER ONLY http://127.0.0.1:18789'));
async function stop(){await server.shutdown();await fs.rm(temporary,{recursive:true,force:true});process.exit(0);}
process.once('SIGTERM',stop);process.once('SIGINT',stop);
