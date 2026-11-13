# 按专科在 Europe PMC 检索 PLOS One 临床研究（CC BY），下载全文 XML，筛出带公开审稿记录、≥2 张表、有效应量的文章
import json,subprocess,urllib.parse,re,os,sys,time
os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.makedirs('xml',exist_ok=True)
SPEC={'心血管':'heart failure OR atrial fibrillation OR myocardial infarction','内分泌':'diabetes OR insulin','肾内':'chronic kidney disease OR dialysis',
'神经':'stroke OR dementia OR epilepsy','儿科':'children OR neonatal OR infants','感染':'tuberculosis OR sepsis OR HIV','消化':'cirrhosis OR colorectal OR hepatitis',
'呼吸':'COPD OR asthma OR pneumonia','风湿':'rheumatoid arthritis OR lupus','产科':'pregnancy OR preeclampsia OR gestational','骨科':'fracture OR arthroplasty',
'精神':'depression OR schizophrenia','眼科':'glaucoma OR retinopathy OR cataract','急诊重症':'intensive care OR emergency department','老年':'older adults OR frailty',
'泌尿':'prostate OR bladder','血液':'anemia OR lymphoma OR leukemia','外科':'surgery OR postoperative complications'}
def get(url):
    return subprocess.run(['curl','-sS','-m','40',url],capture_output=True).stdout
picked=[]
for sp,kw in SPEC.items():
    q=f'JOURNAL:"PLoS One" AND OPEN_ACCESS:y AND PUB_YEAR:[2021 TO 2025] AND TITLE:({kw}) AND (TITLE:cohort OR TITLE:retrospective OR TITLE:randomized OR TITLE:"cross-sectional")'
    url='https://www.ebi.ac.uk/europepmc/webservices/rest/search?format=json&pageSize=25&resultType=lite&query='+urllib.parse.quote(q)
    res=json.loads(get(url)).get('resultList',{}).get('result',[])
    got=None
    for r in res:
        pmc=r.get('pmcid'); 
        if not pmc: continue
        p=f'xml/{pmc}.xml'
        if not os.path.exists(p): open(p,'wb').write(get(f'https://www.ebi.ac.uk/europepmc/webservices/rest/{pmc}/fullTextXML')); time.sleep(.2)
        t=open(p,errors='ignore').read()
        rev='aggregated-review-documents' in t or 'reviewer-report' in t
        tbl=len(re.findall(r'<table-wrap[ >]',t)); eff=len(re.findall(r'(HR|OR|RR|aOR|aHR)[ ,=:]+\d|95% ?CI',t))
        lic='creativecommons.org/licenses/by/' in t
        if rev and tbl>=2 and eff>=5 and lic:
            got=dict(spec=sp,pmc=pmc,doi=r.get('doi'),title=r.get('title'),year=r.get('pubYear'),tables=tbl,effects=eff); break
        else: os.remove(p)
    print(sp, got and (got['pmc'],got['title'][:70]) , file=sys.stderr)
    if got: picked.append(got)
json.dump(picked,open('others.json','w'),ensure_ascii=False,indent=1)
print(len(picked))
