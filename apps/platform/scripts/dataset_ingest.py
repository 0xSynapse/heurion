"""数据集导入（平台在用户的隔离环境里运行它：上传的文件不可信，解析不在平台进程里做）。

  python3 dataset_ingest.py <输入文件> <输出目录> [--drop 列名 ...]

读 CSV / TSV / TXT（UTF-8 或 GBK）、Excel（第一个工作表）、SAS（.xpt / .sas7bdat）、SPSS（.sav）、Stata（.dta），
输出：
  data.csv      UTF-8 的规范表（--drop 指定的列已删掉）
  profile.json  行数、每列的类型 / 缺失 / 唯一值 / 统计摘要、原文件里的变量标签，以及疑似身份信息的列
"""
import json
import math
import re
import sys
from pathlib import Path

import pandas as pd

MAX_ROWS = 2_000_000

# 疑似身份信息：列名，或取值的格式（身份证号、手机号、邮箱）
NAME_PATTERNS = [
    (re.compile(r'(姓名|名字|患者名|病人名|^name$|full_?name|patient_?name|first_?name|last_?name|surname)', re.I), '姓名'),
    (re.compile(r'(身份证|证件号|id_?card|national_?id|ssn|passport|护照)', re.I), '证件号'),
    (re.compile(r'(电话|手机|联系方式|phone|mobile|tel$|telephone)', re.I), '电话'),
    (re.compile(r'(病历号|住院号|门诊号|病案号|就诊号|登记号|医保号|mrn|medical_?record|admission_?no|hospital_?no)', re.I), '病历号 / 住院号'),
    (re.compile(r'(住址|地址|家庭住址|address|street|zip|邮编|postcode)', re.I), '地址'),
    (re.compile(r'(出生日期|生日|birth_?date|date_?of_?birth|^dob$|birthday)', re.I), '出生日期'),
    (re.compile(r'(邮箱|e-?mail)', re.I), '邮箱'),
]
VALUE_PATTERNS = [
    (re.compile(r'^\d{17}[\dXx]$'), '身份证号'),
    (re.compile(r'^(\+?86[- ]?)?1[3-9]\d{9}$'), '手机号'),
    (re.compile(r'^[\w.+-]+@[\w-]+\.[\w.-]+$'), '邮箱'),
]


def read(path: Path) -> tuple[pd.DataFrame, dict]:
    ext = path.suffix.lower()
    labels: dict = {}
    if ext in ('.csv', '.tsv', '.txt'):
        sep = '\t' if ext == '.tsv' else None
        for enc in ('utf-8-sig', 'gb18030'):
            try:
                return pd.read_csv(path, sep=sep, engine='python', encoding=enc, nrows=MAX_ROWS), labels
            except UnicodeDecodeError:
                continue
        raise ValueError('无法识别文件编码（试过 UTF-8 与 GBK）')
    if ext in ('.xlsx', '.xlsm', '.xls'):
        return pd.read_excel(path, sheet_name=0, nrows=MAX_ROWS), labels
    if ext in ('.xpt', '.sas7bdat'):
        df = pd.read_sas(path, format='xport' if ext == '.xpt' else 'sas7bdat', encoding='utf-8' if ext == '.sas7bdat' else None)
        return df, labels
    if ext in ('.sav', '.zsav', '.dta'):
        try:
            import pyreadstat
            df, meta = (pyreadstat.read_sav if ext != '.dta' else pyreadstat.read_dta)(str(path), apply_value_formats=True)
            labels = {k: v for k, v in zip(meta.column_names, meta.column_labels or []) if v}
            return df, labels
        except ImportError:
            if ext == '.dta':
                return pd.read_stata(path), labels
            raise ValueError('读取 SPSS 文件需要 pyreadstat')
    raise ValueError(f'不支持的格式：{ext}')


# 临床数据表常见缺失值占位符（中文「缺失 / 未知 / 不详」及常见英文 NA 标记）
MISSING_RE = re.compile(r'^(缺失|缺失值|未知|不详|未记录|未查|无数据|na|n/a|null|none|nan|-|—|--|\.|/)$', re.I)


def clean_missing_and_types(df: pd.DataFrame) -> pd.DataFrame:
    """将临床表格中的文本型缺失占位符（如「缺失」、纯数值/日期列里的 'N'）转为缺失值，并恢复被污染的数值列类型。"""
    for c in df.columns:
        s = df[c]
        if s.dtype != object:
            continue
        stripped = s.map(lambda v: v.strip() if isinstance(v, str) else v)
        mask = stripped.map(lambda v: bool(MISSING_RE.match(v)) if isinstance(v, str) else False)
        # 若列中没有 'Y'/'Yes'，而有单独的 'N'，且其余非空值 >=80% 是数值或日期，则 'N' 也是缺失/未做占位符
        non_empty = stripped[~mask].dropna()
        if len(non_empty):
            upper_vals = non_empty.map(lambda v: v.upper() if isinstance(v, str) else '')
            has_n = (upper_vals == 'N').any()
            has_y = upper_vals.isin(('Y', 'YES')).any()
            rest = non_empty[upper_vals != 'N']
            if has_n and not has_y and len(rest) > 0:
                num_ratio = pd.to_numeric(rest, errors='coerce').notna().mean()
                date_ratio = rest.astype(str).str.contains(r'\d{4}').mean()
                if num_ratio >= 0.8 or date_ratio >= 0.8:
                    mask = mask | ( stripped.map(lambda v: isinstance(v, str) and v.strip().upper() == 'N') )
        if mask.any():
            s = s.mask(mask, pd.NA)
            df[c] = s
        # 去掉缺失占位符后，若剩余非空值全部可转为数值，则还原为数值列（例如含「缺失」的供血动脉数量、含 'N' 的中心剂量）
        nonnull = df[c].dropna()
        if len(nonnull) > 0:
            coerced = pd.to_numeric(nonnull, errors='coerce')
            if coerced.notna().all():
                df[c] = pd.to_numeric(df[c], errors='coerce')
    return df


def _is_date_series(s: pd.Series) -> bool:
    if pd.api.types.is_datetime64_any_dtype(s):
        return True
    nonnull = s.dropna().astype(str).str.strip()
    # 临床事件时间列常以 '0' 表示未发生事件（如未治疗、未出血），判断是否为日期列时排除 '0'
    non_zero = nonnull[~nonnull.isin(('0', '0.0', ''))]
    if len(non_zero) == 0:
        return False
    sample = non_zero.head(200)
    has_year = sample.str.contains(r'\d{4}').mean() >= 0.85
    if not has_year:
        return False
    cleaned = sample.str.replace(r'[术后前约左右]+$', '', regex=True)
    parsed = pd.to_datetime(cleaned, errors='coerce', format='mixed')
    return bool(parsed.notna().mean() >= 0.85)


def col_type(s: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(s):
        return 'categorical'
    if pd.api.types.is_numeric_dtype(s):
        # 取值很少的整数（如 0/1、1–4 分期）也当分类
        return 'categorical' if s.dropna().nunique() <= 5 and (s.dropna() % 1 == 0).all() else 'numeric'
    if _is_date_series(s):
        return 'date'
    nonnull = s.dropna().astype(str)
    return 'categorical' if nonnull.nunique() <= max(20, len(nonnull) * 0.05) else 'text'


def num(x):
    return None if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else round(float(x), 4)


def phi(name: str, s: pd.Series) -> dict | None:
    for pat, why in NAME_PATTERNS:
        if pat.search(str(name)):
            return {'reason': f'列名像{why}'}
    vals = s.dropna().astype(str).str.strip()
    if len(vals) == 0:
        return None
    sample = vals.head(2000)
    for pat, why in VALUE_PATTERNS:
        hits = int(sample.map(lambda v: bool(pat.match(v))).sum())
        if hits >= max(1, len(sample) * 0.02):
            return {'reason': f'取值像{why}（抽查 {len(sample)} 个，{hits} 个匹配）'}
    return None


def profile(df: pd.DataFrame, labels: dict) -> dict:
    cols = []
    for name in df.columns:
        s = df[name]
        t = col_type(s)
        c = {'name': str(name), 'type': t, 'missing': int(s.isna().sum()), 'unique': int(s.nunique(dropna=True))}
        if str(name) in labels:
            c['label'] = labels[str(name)]
        if t == 'numeric':
            d = s.dropna().astype(float)
            if len(d):
                c['stats'] = {'mean': num(d.mean()), 'sd': num(d.std()), 'median': num(d.median()), 'q1': num(d.quantile(.25)), 'q3': num(d.quantile(.75)), 'min': num(d.min()), 'max': num(d.max())}
        elif t in ('categorical', 'text'):
            top = s.dropna().astype(str).value_counts().head(8)
            c['top'] = [{'value': str(k)[:60], 'count': int(v)} for k, v in top.items()]
        elif t == 'date':
            non_zero = s.dropna().astype(str).str.strip()
            non_zero = non_zero[~non_zero.isin(('0', '0.0', ''))].str.replace(r'[术后前约左右]+$', '', regex=True)
            d = pd.to_datetime(non_zero, errors='coerce', format='mixed').dropna()
            if len(d):
                c['range'] = [d.min().date().isoformat(), d.max().date().isoformat()]
        flag = phi(name, s)
        if flag:
            c['phi'] = flag
        cols.append(c)
    return {'rows': int(len(df)), 'columns': cols}


def main() -> None:
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    drop = sys.argv[sys.argv.index('--drop') + 1:] if '--drop' in sys.argv else []
    out.mkdir(parents=True, exist_ok=True)
    try:
        df, labels = read(src)
        df.columns = [str(c).strip() or f'col{i + 1}' for i, c in enumerate(df.columns)]
        if df.columns.duplicated().any():
            raise ValueError('有重名的列：' + '、'.join(sorted(set(df.columns[df.columns.duplicated()]))))
        df = df.drop(columns=[c for c in drop if c in df.columns])
        df = clean_missing_and_types(df)
        # 有缺失的整数列被 pandas 读成小数（1.0、2.0）：取值全是整数的改回整数，CSV 与概况里都写成 1、2
        for c in df.columns:
            if pd.api.types.is_float_dtype(df[c]):
                vals = df[c].dropna()
                if len(vals) and (vals % 1 == 0).all() and vals.abs().max() < 2**53:
                    df[c] = df[c].astype('Int64')
        # SAS 的字节串列转成文字
        for c in df.columns:
            if df[c].dtype == object and df[c].map(lambda v: isinstance(v, bytes)).any():
                df[c] = df[c].map(lambda v: v.decode('utf-8', 'replace') if isinstance(v, bytes) else v)
        df.to_csv(out / 'data.csv', index=False)
        result = {'ok': True, **profile(df, labels), 'truncated': len(df) >= MAX_ROWS}
    except Exception as err:  # noqa: BLE001 — 失败原因原样给用户
        result = {'ok': False, 'error': str(err)[:500]}
    (out / 'profile.json').write_text(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
