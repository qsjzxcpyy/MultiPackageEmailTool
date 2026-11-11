"""Headless entry point. Sending requires an explicit --web-worker manifest."""
import argparse
from mail_engine import web_worker, offline_self_test, offline_web_worker_test

def main():
    parser = argparse.ArgumentParser(description='Local webpage mail worker')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--web-worker', metavar='MANIFEST')
    mode.add_argument('--offline-self-test', metavar='REPORT')
    mode.add_argument('--offline-web-worker-test', metavar='REPORT')
    args = parser.parse_args()
    if args.web_worker:
        web_worker(args.web_worker)
    elif args.offline_self_test:
        offline_self_test(args.offline_self_test)
    else:
        offline_web_worker_test(args.offline_web_worker_test)

if __name__ == '__main__':
    main()
