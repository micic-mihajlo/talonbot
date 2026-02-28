#!/usr/bin/env python3
import argparse
import json
import sys

try:
    from scrapling.fetchers import Fetcher
except Exception as e:  # pragma: no cover
    print(json.dumps({"ok": False, "error": f"scrapling_import_failed: {e}"}))
    sys.exit(2)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch a page with Scrapling and return JSON")
    parser.add_argument("url", help="Target URL")
    parser.add_argument("--selector", help="Optional CSS selector")
    parser.add_argument("--timeout", type=int, default=20, help="Request timeout seconds")
    args = parser.parse_args()

    try:
        page = Fetcher(timeout=args.timeout).get(args.url)
        title = None
        try:
            title_nodes = page.css("title")
            title = title_nodes[0].text if len(title_nodes) else None
        except Exception:
            title = None

        payload = {
            "ok": True,
            "url": args.url,
            "title": title,
        }

        if args.selector:
            nodes = page.css(args.selector)
            payload["selector"] = args.selector
            payload["count"] = len(nodes)
            payload["items"] = [n.text.strip() for n in list(nodes)[:20]]
        else:
            text = page.text or ""
            payload["text_preview"] = text.strip()[:1000]

        print(json.dumps(payload, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e), "url": args.url}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
