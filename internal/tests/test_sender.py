"""Offline regression tests. All SMTP connections are replaced before any send."""
import contextlib
import importlib.util
import io
import json
import os
import smtplib
import socket
import tempfile
import unittest
from pathlib import Path

from openpyxl import Workbook

ROOT = Path(__file__).resolve().parent
SOURCE = Path(os.environ.get('EMAIL_ENGINE_SOURCE', ROOT.parent / 'worker' / 'mail_engine.py'))
spec = importlib.util.spec_from_file_location('sender_under_test', SOURCE)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


@contextlib.contextmanager
def patched(obj, name, value):
    original = getattr(obj, name)
    setattr(obj, name, value)
    try:
        yield
    finally:
        setattr(obj, name, original)


def reject_network(*args, **kwargs):
    raise AssertionError('Real network prohibited')


class Log:
    def __init__(self):
        self.messages = []

    def send_log(self, level, text):
        self.messages.append((level, text))


class SMTP:
    accepted = []
    actions = []
    quits_fail = False
    connections = 0
    connect_errors = []
    login_errors = []
    submissions = 0

    def __init__(self, *args, **kwargs):
        type(self).connections += 1
        if self.connect_errors:
            raise self.connect_errors.pop(0)

    def login(self, *args):
        if self.login_errors:
            raise self.login_errors.pop(0)
        return (235, b'ok')

    def starttls(self, *args, **kwargs):
        return (220, b'ok')

    def sendmail(self, sender, receivers, message):
        type(self).submissions += 1
        action = self.actions.pop(0) if self.actions else None
        if isinstance(action, BaseException):
            raise action
        if action:
            return action
        self.accepted.extend(receivers)
        return {}

    def quit(self):
        if self.quits_fail:
            raise smtplib.SMTPServerDisconnected('QUIT disconnected after acceptance')

    def close(self):
        pass


class SenderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.old_cwd = os.getcwd()
        os.chdir(self.temp.name)
        self.addCleanup(os.chdir, self.old_cwd)
        self.log = Log()
        SMTP.accepted, SMTP.actions, SMTP.quits_fail = [], [], False
        SMTP.connections, SMTP.submissions = 0, 0
        SMTP.connect_errors, SMTP.login_errors = [], []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patched(smtplib, 'SMTP_SSL', SMTP))
        self.stack.enter_context(patched(smtplib, 'SMTP', SMTP))
        self.stack.enter_context(patched(socket, 'create_connection', reject_network))
        if hasattr(engine, 'time'):
            self.stack.enter_context(patched(engine.time, 'sleep', lambda _: None))
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        Path('auth.txt').write_text('sender@163.com----fake-code\n', encoding='utf-8')

    def workbook(self, rows, headers=True):
        wb = Workbook()
        if headers:
            wb.active.append(['收件邮箱', '邮件内容', '发件邮箱'])
        for row in rows:
            wb.active.append(row)
        wb.save('input.xlsx')

    def run_batch(self):
        return engine.Zhu_Class(self.log, 'input.xlsx', 'auth.txt')

    def row(self, number=1, sender='sender@163.com'):
        return [f'buyer{number}@example.com', f'正文 {number}', sender]

    def test_retries_explicit_temporary_rejection_without_dropping_row(self):
        self.workbook([self.row(1), self.row(2)])
        SMTP.actions = [smtplib.SMTPDataError(451, b'temporarily unavailable')]
        self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer1@example.com', 'buyer2@example.com'])

    def test_permanent_failure_is_visible_and_next_row_is_sent(self):
        self.workbook([self.row(1), self.row(2)])
        SMTP.actions = [smtplib.SMTPRecipientsRefused({'buyer1@example.com': (550, b'no such user')})]
        result = self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer2@example.com'])
        self.assertTrue(any(level == 'ERROR' and 'buyer1@example.com' in text for level, text in self.log.messages))
        self.assertEqual(result['failed'], 1)
        self.assertTrue(Path(result['report_path']).is_file())

    def test_unsupported_sender_never_reports_success(self):
        Path('auth.txt').write_text('sender@example.com----fake-code\n', encoding='utf-8')
        self.workbook([self.row(sender='sender@example.com')])
        self.run_batch()
        self.assertFalse(any('发送成功' in text for _, text in self.log.messages))
        self.assertTrue(any(level == 'ERROR' for level, _ in self.log.messages))

    def test_quit_failure_after_acceptance_does_not_lose_or_repeat_row(self):
        self.workbook([self.row()])
        SMTP.quits_fail = True
        result = self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer1@example.com'])
        self.assertEqual(result['sent'], 1)

    def test_repeated_batch_skips_already_confirmed_rows(self):
        self.workbook([self.row(1), self.row(2)])
        self.run_batch()
        self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer1@example.com', 'buyer2@example.com'])

    def test_uncertain_data_disconnect_is_recorded_and_not_automatically_retried(self):
        self.workbook([self.row()])
        SMTP.actions = [smtplib.SMTPServerDisconnected('lost DATA acknowledgement')]
        result = self.run_batch()
        self.assertEqual(result['uncertain'], 1)
        second = self.run_batch()
        self.assertEqual(second['uncertain'], 1)
        self.assertEqual(SMTP.accepted, [])

    def test_utf8_bom_auth_and_address_case_are_normalized(self):
        Path('auth.txt').write_text(' SENDER@163.COM ---- fake-code \n', encoding='utf-8-sig')
        self.workbook([self.row()])
        self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer1@example.com'])

    def test_all_58_rows_processed_with_temporary_failures_and_blanks(self):
        rows = [self.row(i) for i in range(1, 59)]
        rows.insert(9, [None, None, None])
        self.workbook(rows)
        SMTP.actions = [smtplib.SMTPDataError(451, b'busy'), None,
                        smtplib.SMTPDataError(451, b'busy'), None]
        result = self.run_batch()
        self.assertEqual(SMTP.accepted, [f'buyer{i}@example.com' for i in range(1, 59)])
        self.assertEqual((result['total'], result['sent'], result['failed']), (58, 58, 0))

    def test_missing_fields_are_reported_with_original_excel_rows(self):
        self.workbook([['', 'text', 'sender@163.com'], self.row(2),
                       ['buyer3@example.com', '', 'sender@163.com'],
                       ['buyer4@example.com', 'text', '']])
        result = self.run_batch()
        self.assertEqual((result['sent'], result['failed'], result['total']), (1, 3, 4))
        records = json.loads(Path(result['journal_path']).read_text(encoding='utf-8'))['records']
        self.assertEqual([r['row'] for r in records if r['status'] == 'failed'], [2, 4, 5])

    def test_workbook_without_headers_includes_first_mail(self):
        self.workbook([self.row(1), self.row(2)], headers=False)
        self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer1@example.com', 'buyer2@example.com'])

    def test_named_columns_can_be_reordered(self):
        wb = Workbook()
        wb.active.append(['发件邮箱', '备注', '收件邮箱', '邮件内容'])
        wb.active.append(['sender@163.com', '', 'buyer1@example.com', '邮件正文'])
        wb.save('input.xlsx')
        self.run_batch()
        self.assertEqual(SMTP.accepted, ['buyer1@example.com'])

    def test_temporary_retries_are_bounded_and_do_not_drop_next_row(self):
        self.workbook([self.row(1), self.row(2)])
        SMTP.actions = [smtplib.SMTPDataError(451, b'busy') for _ in range(3)]
        result = self.run_batch()
        self.assertEqual(SMTP.submissions, 4)
        self.assertEqual(SMTP.accepted, ['buyer2@example.com'])
        self.assertEqual(result['failed'], 1)

    def test_returned_refusal_dictionary_is_not_success(self):
        self.workbook([self.row()])
        SMTP.actions = [{'buyer1@example.com': (550, b'rejected')}]
        result = self.run_batch()
        self.assertEqual((result['sent'], result['failed']), (0, 1))

    def test_connect_failure_retries_before_submission(self):
        self.workbook([self.row()])
        SMTP.connect_errors = [TimeoutError('connect timed out')]
        result = self.run_batch()
        self.assertEqual((result['sent'], SMTP.connections, SMTP.submissions), (1, 2, 1))

    def test_authentication_failure_is_not_retried_or_logged_with_secret(self):
        self.workbook([self.row()])
        SMTP.login_errors = [smtplib.SMTPAuthenticationError(535, b'fake-code rejected')]
        result = self.run_batch()
        self.assertEqual((result['failed'], SMTP.connections, SMTP.submissions), (1, 1, 0))
        self.assertNotIn('fake-code', repr(self.log.messages))
        self.assertNotIn('fake-code', Path(result['report_path']).read_text(encoding='utf-8-sig'))

    def test_interrupted_submission_is_not_sent_again(self):
        self.workbook([self.row()])
        sheet, rows = engine.read_rows('input.xlsx')
        identifier = engine.batch_id(sheet, rows)
        state = Path('发送记录')
        state.mkdir()
        record = dict(row=2, recipient=rows[0]['recipient'], sender=rows[0]['sender'],
                      status='sending', attempts=1, detail='interrupted', message_id='<test@example.com>')
        (state / (identifier + '.json')).write_text(json.dumps({'batch_id': identifier, 'records': [record]}), encoding='utf-8')
        result = self.run_batch()
        self.assertEqual(result['uncertain'], 1)
        self.assertEqual(SMTP.connections, 0)

    def test_journal_write_failure_stops_before_any_connection(self):
        self.workbook([self.row()])
        def fail_write(*args):
            raise PermissionError('simulation: disk not writable')
        with patched(engine, 'atomic_json', fail_write):
            with self.assertRaises(PermissionError):
                self.run_batch()
        self.assertEqual(SMTP.connections, 0)

    def test_same_batch_lock_prevents_parallel_sending(self):
        self.workbook([self.row()])
        sheet, rows = engine.read_rows('input.xlsx')
        state = Path('发送记录')
        state.mkdir()
        with engine.BatchLock(state / (engine.batch_id(sheet, rows) + '.lock')):
            with self.assertRaises(RuntimeError):
                self.run_batch()
        self.assertEqual(SMTP.connections, 0)

    def test_QQ_login_disconnect_reconnects_before_submission(self):
        Path('auth.txt').write_text('ze-demo@qq.com----fake-qq-code\n', encoding='utf-8')
        self.workbook([self.row(sender='ze-demo@qq.com')])
        SMTP.login_errors = [smtplib.SMTPServerDisconnected('Connection unexpectedly closed')]
        SMTP.quits_fail = True
        result = self.run_batch()
        self.assertEqual((result['sent'], result['failed']), (1, 0))
        self.assertEqual((SMTP.connections, SMTP.submissions), (2, 1))
        self.assertEqual(SMTP.accepted, ['buyer1@example.com'])

    def test_mixed_95_row_batch_with_16_QQ_rows_and_login_disconnects(self):
        class QQInterrupted(SMTP):
            qq_connections = 0

            def __init__(self, host, *args, **kwargs):
                super().__init__(host, *args, **kwargs)
                self.host = host

            def login(self, *args):
                if self.host == 'smtp.qq.com':
                    type(self).qq_connections += 1
                    if self.qq_connections % 2:
                        raise smtplib.SMTPServerDisconnected('Connection unexpectedly closed')
                return super().login(*args)

        Path('auth.txt').write_text('sender@163.com----fake-code\nze-demo@qq.com----fake-qq-code', encoding='utf-8')
        self.workbook([self.row(i, 'ze-demo@qq.com' if i <= 16 else 'sender@163.com') for i in range(1, 96)])
        with patched(smtplib, 'SMTP_SSL', QQInterrupted):
            result = self.run_batch()
        self.assertEqual((result['total'], result['sent'], result['failed']), (95, 95, 0))
        self.assertEqual(QQInterrupted.qq_connections, 32)
        self.assertEqual(SMTP.accepted, [f'buyer{i}@example.com' for i in range(1, 96)])


if __name__ == '__main__':
    result = unittest.main(exit=False, verbosity=2).result
    if not result.wasSuccessful():
        raise RuntimeError('Offline regression tests failed')
