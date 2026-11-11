"""Row-by-row mail delivery with durable, inspectable outcomes.

The three-column workbook and Zhu_Class entry point match the original UI.
"""
import csv
import hashlib
import json
import os
import re
import smtplib
import ssl
import sys
import time
from datetime import datetime
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path

from openpyxl import load_workbook

HEADERS = ('收件邮箱', '邮件内容', '发件邮箱')
MAX_ATTEMPTS = 3
SEND_INTERVAL = 1.0
TIMEOUT = 30
STATUS_LABELS = {'sent': '服务器已接收', 'failed': '发送失败',
                 'uncertain': '结果不确定，需核对', 'sending': '处理中断，需核对',
                 'pending': '待处理'}


class DeliveryError(Exception):
    def __init__(self, message, *, retryable=False, uncertain=False):
        super().__init__(message)
        self.retryable = retryable
        self.uncertain = uncertain


def application_dir():
    return Path(sys.executable).resolve().parent if getattr(sys, 'frozen', False) else Path.cwd()


def get_smtp_for_sender(sender_email):
    domain = sender_email.strip().lower().rsplit('@', 1)[-1]
    servers = {'qq.com': 'smtp.qq.com', '163.com': 'smtp.163.com',
               '126.com': 'smtp.126.com', 'yeah.net': 'smtp.yeah.net'}
    if domain not in servers:
        raise ValueError('不支持的发件邮箱类型：' + domain)
    return servers[domain], 465


def send_email(smtp_server, smtp_port, username, password, subject, content,
               receivers, sender_alias=None, use_ssl=True, message_id=None):
    msg = MIMEMultipart()
    msg['Subject'] = subject
    msg['From'] = formataddr((sender_alias or username, username))
    msg['To'] = ','.join(receivers)
    msg['Date'] = formatdate(localtime=True)
    msg['Message-ID'] = message_id or make_msgid()
    msg.attach(MIMEText(content, 'plain', 'utf-8'))
    payload = msg.as_string()
    server = None
    phase = 'connect'
    try:
        if use_ssl:
            server = smtplib.SMTP_SSL(smtp_server, smtp_port, timeout=TIMEOUT,
                                      context=ssl.create_default_context())
        else:
            server = smtplib.SMTP(smtp_server, smtp_port, timeout=TIMEOUT)
            server.starttls(context=ssl.create_default_context())
        phase = 'login'
        server.login(username, password)
        phase = 'submit'
        refused = server.sendmail(username, receivers, payload)
        if refused:
            # The UI submits exactly one recipient per row.
            codes = [v[0] for v in refused.values()]
            raise DeliveryError('收件服务器拒收：' + ','.join(map(str, codes)),
                                retryable=all(400 <= c < 500 for c in codes))
    except DeliveryError:
        raise
    except smtplib.SMTPRecipientsRefused as exc:
        codes = [v[0] for v in exc.recipients.values()]
        raise DeliveryError('收件地址被拒绝：' + ','.join(map(str, codes)),
                            retryable=bool(codes) and all(400 <= c < 500 for c in codes)) from exc
    except smtplib.SMTPResponseException as exc:
        # An explicit negative DATA response means the message was not accepted.
        raise DeliveryError('SMTP 拒绝，状态码 ' + str(exc.smtp_code),
                            retryable=400 <= exc.smtp_code < 500) from exc
    except (OSError, smtplib.SMTPServerDisconnected) as exc:
        raise DeliveryError('连接中断或超时（' + phase + '）',
                            retryable=phase != 'submit', uncertain=phase == 'submit') from exc
    except Exception as exc:
        raise DeliveryError('发送处理异常：' + type(exc).__name__,
                            uncertain=phase == 'submit') from exc
    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:
                try:
                    server.close()
                except Exception:
                    pass


def send_by_163(username, password, subject, content, receivers, sender_alias=None):
    server, port = get_smtp_for_sender(username)
    return send_email(server, port, username, password, subject, content, receivers, sender_alias)


def send_by_qq(username, password, subject, content, receivers, sender_alias=None):
    return send_by_163(username, password, subject, content, receivers, sender_alias)


def cell_text(value):
    return '' if value is None else str(value).strip()


def valid_address(address):
    return bool(re.fullmatch(r'[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+', address))


def read_credentials(filename):
    raw = Path(filename).read_bytes()
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        raise ValueError('无法读取授权码文件编码')
    credentials = {}
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        if '----' not in line:
            raise ValueError(f'授权码文件第 {number} 行缺少 ---- 分隔符')
        sender, secret = (part.strip() for part in line.split('----', 1))
        sender = sender.casefold()
        if not valid_address(sender) or not secret:
            raise ValueError(f'授权码文件第 {number} 行格式不完整')
        if sender in credentials and credentials[sender] != secret:
            raise ValueError(f'授权码文件第 {number} 行存在重复冲突')
        credentials[sender] = secret
    return credentials


def read_rows(filename):
    workbook = load_workbook(filename, read_only=True, data_only=True)
    try:
        sheet = workbook.worksheets[0]
        rows = []
        columns = (0, 1, 2)
        for number, values in enumerate(sheet.iter_rows(values_only=True), 1):
            cells = [cell_text(v) for v in values]
            if not any(cells):
                continue
            if not rows and all(header in cells for header in HEADERS):
                columns = tuple(cells.index(header) for header in HEADERS)
                continue
            selected = [cells[i] if i < len(cells) else '' for i in columns]
            rows.append({'row': number, 'recipient': selected[0], 'content': selected[1],
                         'sender': selected[2].casefold()})
        return sheet.title, rows
    finally:
        workbook.close()


def batch_id(sheet, rows):
    payload = json.dumps([sheet, rows], ensure_ascii=False, sort_keys=True).encode('utf-8')
    return hashlib.sha256(payload).hexdigest()


def atomic_json(filename, value):
    temporary = filename.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    for attempt in range(20):
        try:
            os.replace(temporary, filename)
            break
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.025)


class BatchLock:
    def __init__(self, path):
        self.path = path

    def __enter__(self):
        import msvcrt
        self.stream = self.path.open('a+b')
        self.stream.seek(0, 2)
        if self.stream.tell() == 0:
            self.stream.write(b'0')
            self.stream.flush()
        self.stream.seek(0)
        try:
            msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.stream.close()
            raise RuntimeError('同一批邮件已在另一个窗口处理，请勿重复启动')
        return self

    def __exit__(self, *args):
        import msvcrt
        self.stream.seek(0)
        msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
        self.stream.close()


def export_report(path, records):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['Excel行号', '收件邮箱', '发件邮箱', '状态', '尝试次数', '说明', '更新时间'])
        for item in records:
            values = [item['row'], item['recipient'], item['sender'], STATUS_LABELS[item['status']],
                      item['attempts'], item['detail'], item.get('updated', '')]
            # A report can safely be opened in Excel even for malformed inputs.
            writer.writerow(["'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@')) else v
                             for v in values])
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def deliver_batch(signal_manager, excel, auth_file, *, state_dir=None, on_progress=None):
    credentials = read_credentials(auth_file)
    sheet, rows = read_rows(excel)
    identifier = batch_id(sheet, rows)
    directory = Path(state_dir) if state_dir else application_dir() / '发送记录'
    directory.mkdir(parents=True, exist_ok=True)
    journal_path = directory / (identifier + '.json')
    report_path = directory / ('发送结果_' + identifier[:12] + '.csv')
    log = signal_manager.send_log
    with BatchLock(directory / (identifier + '.lock')):
        records = [dict(row=entry['row'], recipient=entry['recipient'], sender=entry['sender'],
                        status='pending', attempts=0, detail='尚未发送', message_id=make_msgid())
                   for entry in rows]
        if journal_path.exists():
            previous = json.loads(journal_path.read_text(encoding='utf-8'))
            if previous.get('batch_id') != identifier or len(previous.get('records', [])) != len(rows):
                raise ValueError('发送记录损坏，已停止，防止重复发送')
            records = previous['records']
            for item, entry in zip(records, rows):
                if (item.get('row'), item.get('recipient'), item.get('sender')) != (
                        entry['row'], entry['recipient'], entry['sender']):
                    raise ValueError('发送记录与表格不匹配，已停止')
                if item['status'] == 'sending':
                    item['status'] = 'uncertain'
                    item['detail'] = '上次发送中断，请先在发件箱或服务商后台核对，未自动补发'

        def save():
            atomic_json(journal_path, {'version': 1, 'batch_id': identifier,
                                      'workbook': str(Path(excel).resolve()), 'sheet': sheet, 'records': records})
            if on_progress is not None:
                on_progress(records)

        save()  # Must be writable before the first network operation.
        skipped = 0
        for entry, item in zip(rows, records):
            label = f"第{entry['row']}行 {entry['recipient']}"
            if item['status'] == 'sent':
                skipped += 1
                log('INFO', label + ' 上次已确认接收，本次跳过')
                continue
            if item['status'] == 'uncertain':
                log('ERROR', label + ' 结果不确定，需人工核对，本次未补发')
                continue
            problem = ''
            if not valid_address(entry['recipient']):
                problem = '收件邮箱为空或格式不正确'
            elif not entry['content']:
                problem = '邮件内容为空'
            elif not valid_address(entry['sender']):
                problem = '发件邮箱为空或格式不正确'
            elif entry['sender'] not in credentials:
                problem = '没有该发件邮箱的授权码'
            else:
                try:
                    get_smtp_for_sender(entry['sender'])
                except ValueError as exc:
                    problem = str(exc)
            if problem:
                item.update(status='failed', detail=problem, updated=datetime.now().isoformat(timespec='seconds'))
                save()
                log('ERROR', label + ' 发送失败：' + problem)
                continue
            for attempt in range(MAX_ATTEMPTS):
                item.update(status='sending', detail='正在提交', attempts=item['attempts'] + 1,
                            updated=datetime.now().isoformat(timespec='seconds'))
                save()  # Interruption after this point requires checking, never blind resending.
                try:
                    server, port = get_smtp_for_sender(entry['sender'])
                    send_email(server, port, entry['sender'], credentials[entry['sender']], '',
                               entry['content'], [entry['recipient']], message_id=item['message_id'])
                except DeliveryError as exc:
                    item.update(status='uncertain' if exc.uncertain else 'failed', detail=str(exc))
                    save()
                    if exc.retryable and attempt + 1 < MAX_ATTEMPTS:
                        log('ERROR', label + f' 临时失败，{attempt + 1}/{MAX_ATTEMPTS} 次，稍后重试')
                        time.sleep(2 ** (attempt + 1))
                        continue
                    log('ERROR', label + ' ' + STATUS_LABELS[item['status']] + '：' + str(exc))
                    break
                else:
                    item.update(status='sent', detail='SMTP服务器确认接收；不等于收件人已读',
                                updated=datetime.now().isoformat(timespec='seconds'))
                    save()
                    log('INFO', label + ' 发送成功（服务器已接收）')
                    break
            time.sleep(SEND_INTERVAL)
        counts = {status: sum(item['status'] == status for item in records)
                  for status in ('sent', 'failed', 'uncertain')}
        counts.update(total=len(rows), skipped=skipped, report_path=str(report_path), journal_path=str(journal_path))
        export_report(report_path, records)
        level = 'ERROR' if counts['failed'] or counts['uncertain'] else 'INFO'
        log(level, f"核对结果：共{len(rows)}条，服务器已接收{counts['sent']}条，失败{counts['failed']}条，"
                   f"待核对{counts['uncertain']}条，本次跳过已成功{skipped}条。结果表：{report_path}")
        return counts


def Zhu_Class(signal_manager, excel, shouquanma):
    try:
        return deliver_batch(signal_manager, excel, shouquanma)
    except Exception as exc:
        # Do not echo secrets or raw SMTP authentication responses to the UI.
        message = str(exc) if isinstance(exc, (ValueError, RuntimeError, PermissionError)) else type(exc).__name__
        signal_manager.send_log('ERROR', '任务已停止，不能视为全部发送成功：' + message)
        raise


def web_worker(manifest_path):
    """Headless entry for the local webpage; no GUI or automatic startup sending."""
    manifest = json.loads(Path(manifest_path).read_text(encoding='utf-8'))
    progress = Path(manifest['progressPath'])
    auth = Path(manifest['authPath'])
    records = []
    if progress.exists():
        records = json.loads(progress.read_text(encoding='utf-8')).get('records', [])

    def snapshot(current):
        nonlocal records
        records = current
        atomic_json(progress, {'phase': 'running', 'pid': os.getpid(), 'records': records})

    class Log:
        def send_log(self, *args):
            pass

    try:
        snapshot(records)
        credentials = read_credentials(auth)
        _, rows = read_rows(manifest['workbook'])
        actual = [[row['recipient'], row['content'], row['sender']] for row in rows]
        if actual != manifest['expectedRows']:
            raise ValueError('发送表与网页记录不一致，已停止发送，请重新生成最终数据')
        missing = sorted({row['sender'] for row in rows if row['sender'] not in credentials})
        if missing:
            raise ValueError('授权码文件缺少发件邮箱：' + '、'.join(missing))
        for row in rows:
            get_smtp_for_sender(row['sender'])
        deliver_batch(Log(), manifest['workbook'], auth, state_dir=manifest['stateDir'], on_progress=snapshot)
        atomic_json(progress, {'phase': 'completed', 'records': records})
    except Exception as exc:
        message = str(exc) if isinstance(exc, (ValueError, RuntimeError)) else '发送处理失败：' + type(exc).__name__
        atomic_json(progress, {'phase': 'error', 'error': message, 'records': records})
    finally:
        auth.unlink(missing_ok=True)


def offline_self_test(destination):
    """Executable smoke check: synthetic workbook, fake SMTP, and network audit guard."""
    import tempfile
    from openpyxl import Workbook

    def prevent_network(event, args):
        if event in ('socket.connect', 'socket.connect_ex', 'socket.getaddrinfo', 'socket.sendto'):
            raise AssertionError('Network is forbidden in offline self-test')

    sys.addaudithook(prevent_network)
    accepted = []
    actions = [smtplib.SMTPDataError(451, b'temporary')]

    class FakeSMTP:
        def __init__(self, *args, **kwargs):
            pass

        def login(self, *args):
            pass

        def sendmail(self, sender, receivers, content):
            if actions:
                raise actions.pop(0)
            accepted.extend(receivers)
            return {}

        def quit(self):
            pass

    class Log:
        def send_log(self, *args):
            pass

    old_smtp, old_sleep = smtplib.SMTP_SSL, time.sleep
    try:
        ssl.create_default_context()
        smtplib.SMTP_SSL, time.sleep = FakeSMTP, lambda _: None
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            wb = Workbook()
            wb.active.append(list(HEADERS))
            for number in range(1, 4):
                wb.active.append([f'buyer{number}@example.com', f'测试邮件{number}', 'demo@163.com'])
            wb.save(root / 'synthetic.xlsx')
            (root / 'synthetic.txt').write_text('demo@163.com----fake-code', encoding='utf-8-sig')
            first = deliver_batch(Log(), root / 'synthetic.xlsx', root / 'synthetic.txt', state_dir=root / 'state')
            second = deliver_batch(Log(), root / 'synthetic.xlsx', root / 'synthetic.txt', state_dir=root / 'state')
            assert first['sent'] == 3 and first['failed'] == 0 and first['uncertain'] == 0, first
            assert second['skipped'] == 3 and len(accepted) == 3
        result = {'ok': True, 'network': 'blocked', 'synthetic_rows': 3, 'confirmed': 3,
                  'temporary_error_retried': True, 'repeat_batch_skipped': 3, 'real_emails_sent': 0}
        Path(destination).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    finally:
        smtplib.SMTP_SSL, time.sleep = old_smtp, old_sleep


def offline_web_worker_test(destination):
    """Exercise packaged webpage bridge against fake SMTP; socket access forbidden."""
    import tempfile
    from openpyxl import Workbook

    def prevent_network(event, args):
        if event in ('socket.connect', 'socket.connect_ex', 'socket.getaddrinfo', 'socket.sendto'):
            raise AssertionError('Network forbidden in offline bridge test')

    sys.addaudithook(prevent_network)
    accepted = []
    submissions = []

    class FakeSMTP:
        def __init__(self, *args, **kwargs): pass
        def login(self, *args): pass
        def sendmail(self, sender, receivers, content):
            recipient = receivers[0]
            submissions.append(recipient)
            if recipient == 'rejected@example.com':
                raise smtplib.SMTPRecipientsRefused({recipient: (550, b'fictional refusal')})
            if recipient == 'uncertain@example.com':
                raise smtplib.SMTPServerDisconnected('fictional disconnect after DATA')
            accepted.append(recipient)
            return {}
        def quit(self): pass

    old_smtp, old_sleep = smtplib.SMTP_SSL, time.sleep
    try:
        smtplib.SMTP_SSL, time.sleep = FakeSMTP, lambda _: None
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = dict(workbook=str(root/'synthetic.xlsx'),authPath=str(root/'fake.txt'),
                            stateDir=str(root/'journal'),progressPath=str(root/'progress.json'))
            expected = [[recipient, 'Synthetic body', 'demo@qq.com'] for recipient in
                        ('accepted@example.com', 'rejected@example.com', 'uncertain@example.com')]
            manifest['expectedRows'] = expected
            wb = Workbook()
            wb.active.append(list(HEADERS))
            for row in expected: wb.active.append(row)
            wb.save(manifest['workbook'])
            manifest_path = root/'manifest.json'
            atomic_json(manifest_path,manifest)
            for iteration in range(2):
                Path(manifest['authPath']).write_text('demo@qq.com----fictional-secret',encoding='utf-8')
                web_worker(manifest_path)
                result = json.loads(Path(manifest['progressPath']).read_text(encoding='utf-8'))
                assert result['phase'] == 'completed', result
                assert [r['status'] for r in result['records']] == ['sent','failed','uncertain']
                assert not Path(manifest['authPath']).exists()
            assert len(accepted) == 1 and len(submissions) == 4
            Path(manifest['authPath']).write_text('other@qq.com----fictional-secret',encoding='utf-8')
            web_worker(manifest_path)
            result = json.loads(Path(manifest['progressPath']).read_text(encoding='utf-8'))
            assert result['phase'] == 'error' and 'demo@qq.com' in result['error']
            assert len(submissions) == 4
            assert not Path(manifest['authPath']).exists()
        atomic_json(Path(destination), dict(ok=True,network='blocked',real_emails_sent=0,
                   synthetic_rows=3,sent=1,failed=1,uncertain=1,duplicate_success_skipped=True,
                   uncertain_not_resent=True,missing_credentials_blocked=True,credentials_cleaned=True))
    finally:
        smtplib.SMTP_SSL, time.sleep = old_smtp, old_sleep
