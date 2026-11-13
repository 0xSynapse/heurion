#!/bin/sh
# 按 qian.json / others.json 从 Europe PMC 下载全文 XML 到 xml/（生成测试稿前先跑一次）
cd "$(dirname "$0")/.." && mkdir -p xml
python3 -c "import json;[print(x['pmc']) for f in ('qian.json','others.json') for x in json.load(open(f))]" | while read p; do
  [ -s "xml/$p.xml" ] || curl -sS -m 60 -o "xml/$p.xml" "https://www.ebi.ac.uk/europepmc/webservices/rest/$p/fullTextXML"
done
ls xml | wc -l
