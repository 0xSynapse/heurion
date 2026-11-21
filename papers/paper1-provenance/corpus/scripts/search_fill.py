# 第二轮检索：search.py 没找到合适文章的专科（心血管、急诊重症；血液与儿科重复）放宽标题条件补齐
import json,subprocess,urllib.parse,re,os,time
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
picked=json.load(open(os.path.join(ROOT,'others.json'))); seen={p['pmc'] for p in picked}
picked=[p for i,p in enumerate(picked) if p['pmc'] not in {q['pmc'] for q in picked[:i]}]
SPEC={'心血管':'hypertension OR coronary OR cardiac OR heart','急诊重症':'ICU OR critically OR mortality OR sepsis','血液':'hemoglobin OR thrombocytopenia OR transfusion OR myeloma'}
get=lambda u: subprocess.run(['curl','-sS','-m','40',u],capture_output=True).stdout
for sp,kw in SPEC.items():
    q=f'JOURNAL:"PLoS One" AND OPEN_ACCESS:y AND PUB_YEAR:[2022 TO 2025] AND TITLE:({kw}) AND ABSTRACT:("hazard ratio" OR "odds ratio")'
    res=json.loads(get('https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=40&resultType=lite&query='+urllib.parse.quote(q))).get('resultList',{}).get('result',[])
    for r in res:
        pmc=r.get('pmcid')
        if not pmc or pmc in seen: continue
        t=get(f'https://www.ebi.ac.uk/europepmc/webservices/rest/{pmc}/fullTextXML').decode('utf8','ignore'); time.sleep(.2)
        rev='aggregated-review-documents' in t or 'reviewer-report' in t
        tbl=len(re.findall(r'<table-wrap[ >]',t)); eff=len(re.findall(r'(HR|OR|RR|aOR|aHR)[ ,=:]+\d|95% ?CI',t))
        if rev and tbl>=2 and eff>=5 and 'creativecommons.org/licenses/by/' in t:
            open(os.path.join(ROOT,'xml',f'{pmc}.xml'),'w').write(t); seen.add(pmc)
            picked.append(dict(spec=sp,pmc=pmc,doi=r.get('doi'),title=r.get('title'),year=r.get('pubYear'),tables=tbl,effects=eff)); print(sp,pmc); break
json.dump(picked,open(os.path.join(ROOT,'others.json'),'w'),ensure_ascii=False,indent=1)
