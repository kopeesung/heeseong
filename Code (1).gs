// ============================================================
// WEALTHOS Family — Code.gs (서버 로직 전용)
// 역할: 데이터 저장/조회, API 처리, HTML 파일 서빙
// HTML 화면은 index.html 파일에서 관리
// ============================================================

// ── 캐시 유틸 (Apps Script CacheService 활용) ─────────────────
const CACHE_TTL = 300; // 5분 (초)
function cacheGet(key) {
  try {
    const c = CacheService.getScriptCache();
    const v = c.get(key);
    return v ? JSON.parse(v) : null;
  } catch(e) { return null; }
}
function cacheSet(key, data) {
  try {
    const c = CacheService.getScriptCache();
    c.put(key, JSON.stringify(data), CACHE_TTL);
  } catch(e) {}
}
function cacheDel(...keys) {
  try {
    const c = CacheService.getScriptCache();
    c.removeAll(keys);
  } catch(e) {}
}

const SH = {
  LEDGER:   '가계부',
  ASSETS:   '자산',
  GOALS:    '목표',
  SETTINGS: '설정',
  MEMBERS:  '가족구성원',
  LOG:      '활동로그',
  CATS:     '카테고리',    // 지출/수입 카테고리 관리
  PAYS:     '결제수단',    // 결제수단 관리
};

const KW = {
  '식비':  ['GS25','CU','세븐일레븐','이마트','홈플러스','롯데마트','마트','슈퍼','편의점'],
  '카페':  ['스타벅스','카페','커피','메가커피','투썸','빽다방','할리스','이디야'],
  '외식':  ['배달의민족','배민','쿠팡이츠','요기요','맥도날드','버거킹','피자','치킨','음식점','식당'],
  '교통':  ['T-money','티머니','지하철','버스','택시','카카오택시','KTX','SRT'],
  '주유':  ['주유소','GS칼텍스','SK에너지','현대오일뱅크'],
  '쇼핑':  ['쿠팡','네이버쇼핑','11번가','올리브영','무신사','G마켓'],
  '구독':  ['넷플릭스','유튜브프리미엄','멜론','스포티파이','ChatGPT','Adobe','Apple'],
  '통신':  ['SKT','KT','LG유플러스','알뜰폰'],
  '의료':  ['병원','약국','의원','내과','치과','한의원'],
  '교육':  ['학원','교육','학습','인강','도서'],
  '급여':  ['급여','월급','임금','봉급'],
  '부업':  ['프리랜서','강의료','외주','알바'],
};

// ============================================================
// 웹앱 진입점 — HTML 화면 or API 응답
// ============================================================
function doGet(e) {
  const p = (e && e.parameter) ? e.parameter : {};

  // ?action=... 파라미터가 있으면 API 응답 (GitHub Pages에서 호출)
  if (p.action) {
    return handleApi(p);
  }

  // 액션 없으면 API 상태 확인용 응답
  return jsonOut({ ok: true, data: { version: '6.0', status: 'WEALTHOS API Ready' } });
}

function doPost(e) {
  try {
    const body = e && e.postData ? e.postData.contents : '{}';
    const p = JSON.parse(body || '{}');
    return handleApi(p);
  } catch(err) {
    return jsonOut({ ok: false, error: err.message });
  }
}

// ============================================================
// API 핸들러 — google.script.run으로 직접 호출됨 (CORS 없음)
// ============================================================
function api(p) {
  // index.html에서 google.script.run.api(params) 로 호출
  try {
    switch (p.action) {
      case 'getDashboard':      return { ok: true, data: getDashboard() };
      case 'getLedger':         return { ok: true, data: getLedger(p) };
      case 'getAssets':         return { ok: true, data: getAssets() };
      case 'getGoals':          return { ok: true, data: getGoals() };
      case 'getMembers':        return { ok: true, data: getMembers() };
      case 'getActivity':       return { ok: true, data: getActivity(30) };
      case 'getBudgets':        return { ok: true, data: getBudgets(SpreadsheetApp.getActiveSpreadsheet()) };
      case 'poll':              return { ok: true, data: poll(p.since || '') };
      case 'addTransaction':    return { ok: true, data: addTransaction(p) };
      case 'updateTransaction': return { ok: true, data: updateTransaction(p) };
      case 'deleteTransaction': return { ok: true, data: deleteTransaction(p) };
      case 'addAsset':          return { ok: true, data: addAsset(p) };
      case 'updateAsset':       return { ok: true, data: updateAsset(p) };
      case 'deleteAsset':       return { ok: true, data: deleteAsset(p) };
      case 'addGoal':           return { ok: true, data: addGoal(p) };
      case 'updateGoal':        return { ok: true, data: updateGoal(p) };
      case 'addMember':         return { ok: true, data: addMember(p) };
      case 'saveSettings':      return { ok: true, data: saveSettings(p) };
      default:                  return { ok: true, data: { version: '6.0' } };
    }
  } catch(err) {
    return { ok: false, error: err.message };
  }
}

// HTTP GET 방식 API (외부 접근용)
function handleApi(p) {
  const result = api(p);
  return jsonOut(result);
}

function jsonOut(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// 폴링 — 실시간 동기화 핵심
// ============================================================
function poll(since) {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const sinceDate = since ? new Date(since) : new Date(0);
  const now       = new Date();
  const newTxns   = getLedgerSince(ss, sinceDate);
  const newLogs   = getLogSince(ss, sinceDate);
  const summary   = getLedgerMonth(ss);
  return {
    timestamp:       now.toISOString(),
    hasChanges:      newTxns.length > 0 || newLogs.length > 0,
    newTransactions: newTxns,
    newActivity:     newLogs,
    summary,
  };
}

function getLedgerSince(ss, since) {
  const sheet = ss.getSheetByName(SH.LEDGER);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues()
    .filter(r => r[0] && r[8]) // ID 있는 행만
    .filter(r => { try { return r[9] && new Date(r[9]) > since; } catch(e) { return false; } })
    .map(rowToTxn).reverse();
}

function getLogSince(ss, since) {
  const sheet = ss.getSheetByName(SH.LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues()
    .filter(r => r[0] && new Date(r[0]) > since)
    .map(r => ({ time: new Date(r[0]).toISOString(), member: r[1], action: r[2], detail: r[3] }))
    .reverse();
}

// ============================================================
// 대시보드
// ============================================================
function getDashboard() {
  // 30초 캐시 — 대시보드는 가장 많이 호출되는 API
  const cached = cacheGet('dashboard');
  if (cached) return cached;

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 가계부를 한 번만 읽어서 여러 계산에 재사용
  const ledgerSheet = ss.getSheetByName(SH.LEDGER);
  const ledgerRows  = (ledgerSheet && ledgerSheet.getLastRow() > 1)
    ? ledgerSheet.getRange(2, 1, ledgerSheet.getLastRow() - 1, 10).getValues()
    : [];

  const totalAssets = sumCol(ss, SH.ASSETS, 4);
  const totalDebts  = Number(getSettingVal(ss, '총부채') || 0);
  const summary     = getLedgerMonthFromRows(ledgerRows);
  const goals       = getGoals();
  const members     = getMembers();
  const activity    = getActivity(15);
  const budgets     = getBudgets(ss);

  const memberExpense = {};
  members.forEach(m => { memberExpense[m.name] = 0; });

  const now = new Date();
  ledgerRows.forEach(r => {
    if (!r[0]) return;
    const d = new Date(r[0]);
    if (d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth()) return;
    if (r[1] === '지출') {
      const who = r[7] || '미지정';
      memberExpense[who] = (memberExpense[who] || 0) + (Number(r[4]) || 0);
    }
  });

  // recentTxns도 이미 읽은 ledgerRows 재사용
  const recentTxns = ledgerRows
    .filter(r => r[0] && r[8])
    .map(rowToTxn)
    .reverse()
    .slice(0, 10);

  const result = {
    totalAssets, totalDebts,
    netWorth:       totalAssets - totalDebts,
    monthlyIncome:  summary.income,
    monthlyExpense: summary.expense,
    savingsRate:    summary.income > 0
      ? Math.round((summary.income - summary.expense) / summary.income * 100) : 0,
    categories:     summary.categories,
    budgets, goals, members, memberExpense,
    recentTxns,
    recentActivity: activity,
    updatedAt:      new Date().toISOString(),
  };
  cacheSet('dashboard', result);
  return result;
}

// ============================================================
// 가계부 — 연/월/일 필터 지원
// ============================================================
function getLedger(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.LEDGER);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const year   = p.year   || '';   // 예: '2025'
  const month  = p.month  || '';   // 예: '2025-03'
  const day    = p.day    || '';   // 예: '2025-03-22'
  const member = p.member || '';
  const limit  = Number(p.limit)  || 0;

  const result = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues()
    .filter(r => {
      if (!r[0] || !r[4]) return false;
      const d   = new Date(r[0]);
      const y   = String(d.getFullYear());
      const ym  = `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const ymd = `${ym}-${String(d.getDate()).padStart(2, '0')}`;
      if (year   && y   !== year)   return false;
      if (month  && ym  !== month)  return false;
      if (day    && ymd !== day)    return false;
      if (member && r[7] !== member) return false;
      return true;
    })
    .map(rowToTxn)
    .reverse();

  return limit > 0 ? result.slice(0, limit) : result;
}

function rowToTxn(r) {
  const d = new Date(r[0]);
  return {
    id:        r[8] || '',
    date:      `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
    type:      r[1], category: r[2], desc: r[3],
    amount:    Number(r[4]) || 0,
    payMethod: r[5], memo: r[6], member: r[7],
    createdAt: r[9] ? new Date(r[9]).toISOString() : '',
  };
}

// ============================================================
// 거래 추가 / 삭제
// ============================================================
function addTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.LEDGER);
  if (!sheet) throw new Error('가계부 시트 없음 — 💰 WEALTHOS 메뉴 > 초기화를 실행하세요');
  if (!p.date || !p.amount) throw new Error('날짜와 금액은 필수입니다');

  let cat = p.category || autoClassify(p.desc || '');
  if (!cat) cat = (p.type === '지출') ? '기타' : '기타수입';

  const id  = Utilities.getUuid();
  const now = new Date().toISOString();
  const lr  = Math.max(sheet.getLastRow(), 1);

  sheet.getRange(lr + 1, 1, 1, 10).setValues([[
    p.date, p.type || '지출', cat, p.desc || '',
    Number(p.amount), p.payMethod || '', p.memo || '',
    p.member || '미지정', id, now,
  ]]);
  sheet.getRange(lr + 1, 5).setNumberFormat('#,##0');
  logActivity(ss, p.member, '거래추가', `${p.type} ${cat} ₩${Number(p.amount).toLocaleString()}`);
  cacheDel('dashboard', 'members', 'goals');

  // 적금/투자 지출 → 연동 자산 금액 자동 증가
  const INVEST_CATS = ['적금', '투자수익', '주식'];
  if (p.type === '지출' && INVEST_CATS.includes(cat) && p.assetId) {
    const aSheet = ss.getSheetByName(SH.ASSETS);
    if (aSheet && aSheet.getLastRow() > 1) {
      const aRows = aSheet.getRange(2, 7, aSheet.getLastRow() - 1, 1).getValues();
      for (let i = 0; i < aRows.length; i++) {
        if (aRows[i][0] === p.assetId) {
          const cur = Number(aSheet.getRange(i + 2, 4).getValue()) || 0;
          aSheet.getRange(i + 2, 4).setValue(cur + Number(p.amount)).setNumberFormat('#,##0');
          logActivity(ss, p.member, '자산연동', `${cat} → 자산 +₩${Number(p.amount).toLocaleString()}`);
          break;
        }
      }
    }
  }

  return { id, category: cat };
}

// ── 자산 금액 조정 헬퍼 ──────────────────────────────────────
// delta: 양수면 증가, 음수면 감소
function adjustAssetValue(ss, assetId, delta, member, reason) {
  if (!assetId || delta === 0) return;
  const sheet = ss.getSheetByName(SH.ASSETS);
  if (!sheet || sheet.getLastRow() < 2) return;
  const rows = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === assetId) {
      const cur    = Number(sheet.getRange(i + 2, 4).getValue()) || 0;
      const newVal = Math.max(0, cur + delta); // 0 이하로는 내려가지 않음
      sheet.getRange(i + 2, 4).setValue(newVal).setNumberFormat('#,##0');
      const sign = delta >= 0 ? '+' : '';
      logActivity(ss, member, '자산연동', `${reason} → 자산 ${sign}₩${delta.toLocaleString()} (합계 ₩${newVal.toLocaleString()})`);
      return;
    }
  }
}

const INVEST_CATS = new Set(['적금', '투자수익', '주식']);

function updateTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.LEDGER);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  if (!p.id) throw new Error('거래 ID가 없습니다');

  const allRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  const targetId = String(p.id).trim();
  for (let i = 0; i < allRows.length; i++) {
    if (String(allRows[i][8]).trim() === targetId) {
      const row = i + 2;

      // 기존 거래 정보 (수정 전)
      const oldType   = allRows[i][1];
      const oldCat    = allRows[i][2];
      const oldAmt    = Number(allRows[i][4]) || 0;
      const oldAsset  = p.oldAssetId || ''; // 클라이언트가 전달

      // 새 카테고리
      let cat = p.category || autoClassify(p.desc || '');
      if (!cat) cat = (p.type === '지출') ? '기타' : '기타수입';

      // 자산 연동 조정:
      // 1) 기존 투자 지출이었으면 → 자산에서 기존 금액 차감
      if (oldType === '지출' && INVEST_CATS.has(oldCat) && oldAsset) {
        adjustAssetValue(ss, oldAsset, -oldAmt, p.member, `거래수정(이전) ${oldCat}`);
      }
      // 2) 새 값이 투자 지출이면 → 자산에 새 금액 추가
      const newAsset = p.assetId || '';
      if (p.type === '지출' && INVEST_CATS.has(cat) && newAsset) {
        adjustAssetValue(ss, newAsset, Number(p.amount), p.member, `거래수정(신규) ${cat}`);
      }

      // 거래 내용 저장
      sheet.getRange(row, 1, 1, 8).setValues([[
        p.date, p.type || '지출', cat, p.desc || '',
        Number(p.amount), p.payMethod || '', p.memo || '', p.member || '미지정',
      ]]);
      sheet.getRange(row, 5).setNumberFormat('#,##0');
      logActivity(ss, p.member, '거래수정', `${p.type} ${cat} ₩${Number(p.amount).toLocaleString()}`);
      cacheDel('dashboard');
      return { updated: true };
    }
  }
  throw new Error('거래를 찾을 수 없습니다');
}

function deleteTransaction(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.LEDGER);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  const allRows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  const delTargetId = String(p.id).trim();
  for (let i = 0; i < allRows.length; i++) {
    if (String(allRows[i][8]).trim() === delTargetId) {
      const oldType  = allRows[i][1];
      const oldCat   = allRows[i][2];
      const oldAmt   = Number(allRows[i][4]) || 0;
      const oldAsset = p.assetId || ''; // 클라이언트가 전달

      // 투자 지출 삭제 → 자산에서 금액 차감
      if (oldType === '지출' && INVEST_CATS.has(oldCat) && oldAsset) {
        adjustAssetValue(ss, oldAsset, -oldAmt, p.member, `거래삭제 ${oldCat}`);
      }

      sheet.deleteRow(i + 2);
      logActivity(ss, p.member, '거래삭제', p.desc || p.id.slice(0, 8));
      cacheDel('dashboard');
      return { deleted: true };
    }
  }
  throw new Error('거래를 찾을 수 없습니다');
}

// ============================================================
// 자산
// ============================================================
function getAssets() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.ASSETS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 7).getValues()
    .filter(r => r[0])
    .map(r => ({
      id: r[6] || '', name: r[0], type: r[1], institution: r[2],
      currentValue: Number(r[3]) || 0, purchaseValue: Number(r[4]) || 0, memo: r[5],
    }));
}

function addAsset(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.ASSETS);
  if (!sheet) throw new Error('자산 시트 없음');
  if (!p.name || !p.currentValue) throw new Error('자산명과 금액은 필수입니다');
  const id = Utilities.getUuid();
  const lr = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(lr + 1, 1, 1, 7).setValues([[
    p.name, p.type || '기타', p.institution || '',
    Number(p.currentValue), Number(p.purchaseValue || p.currentValue),
    p.memo || '', id,
  ]]);
  sheet.getRange(lr + 1, 4, 1, 2).setNumberFormat('#,##0');
  logActivity(ss, p.member, '자산추가', `${p.name} ₩${Number(p.currentValue).toLocaleString()}`);
  cacheDel('dashboard');
  return { id };
}

function updateAsset(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.ASSETS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  const rows = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === p.id) {
      const row = i + 2;
      // 전체 필드 저장 (이름, 유형, 기관, 현재금액, 취득금액, 메모)
      if (p.name        !== undefined) sheet.getRange(row, 1).setValue(p.name);
      if (p.type        !== undefined) sheet.getRange(row, 2).setValue(p.type);
      if (p.institution !== undefined) sheet.getRange(row, 3).setValue(p.institution || '');
      if (p.currentValue  !== undefined) sheet.getRange(row, 4).setValue(Number(p.currentValue)).setNumberFormat('#,##0');
      if (p.purchaseValue !== undefined) sheet.getRange(row, 5).setValue(Number(p.purchaseValue)).setNumberFormat('#,##0');
      if (p.memo        !== undefined) sheet.getRange(row, 6).setValue(p.memo || '');
      logActivity(ss, p.member, '자산수정', p.name || p.id.slice(0, 8));
      return { updated: true };
    }
  }
  throw new Error('자산을 찾을 수 없습니다');
}

function deleteAsset(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.ASSETS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  const rows = sheet.getRange(2, 7, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === p.id) {
      sheet.deleteRow(i + 2);
      logActivity(ss, p.member, '자산삭제', p.name || p.id.slice(0, 8));
      return { deleted: true };
    }
  }
  throw new Error('자산을 찾을 수 없습니다');
}

// ============================================================
// 목표
// ============================================================
function getGoals() {
  const cached = cacheGet('goals');
  if (cached) return cached;
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.GOALS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const result = sheet.getRange(2, 1, sheet.getLastRow() - 1, 8).getValues()
    .filter(r => r[0])
    .map(r => {
      const target = Number(r[2]) || 0, current = Number(r[3]) || 0;
      return {
        id: r[7] || '', name: r[0], type: r[1], target, current,
        targetDate: r[4] ? fmtDate(new Date(r[4])) : '',
        monthly:    Number(r[5]) || 0,
        status:     r[6] || '진행중',
        rate:       target > 0 ? Math.round(current / target * 100) : 0,
        remaining:  Math.max(target - current, 0),
      };
    });
}

function addGoal(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.GOALS);
  if (!sheet) throw new Error('목표 시트 없음');
  if (!p.name || !p.target) throw new Error('목표명과 금액은 필수입니다');
  const id = Utilities.getUuid();
  const lr = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(lr + 1, 1, 1, 8).setValues([[
    p.name, p.type || '기타', Number(p.target), Number(p.current || 0),
    p.targetDate || '', Number(p.monthly || 0), '진행중', id,
  ]]);
  sheet.getRange(lr + 1, 3, 1, 4).setNumberFormat('#,##0');
  logActivity(ss, p.member, '목표추가', `${p.name} ₩${Number(p.target).toLocaleString()}`);
  cacheDel('goals', 'dashboard');
  return { id };
}

function updateGoal(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.GOALS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  const rows = sheet.getRange(2, 8, sheet.getLastRow() - 1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === p.id) {
      if (p.current  !== undefined) sheet.getRange(i + 2, 4).setValue(Number(p.current)).setNumberFormat('#,##0');
      if (p.monthly  !== undefined) sheet.getRange(i + 2, 6).setValue(Number(p.monthly)).setNumberFormat('#,##0');
      if (p.status   !== undefined) sheet.getRange(i + 2, 7).setValue(p.status);
      logActivity(ss, p.member, '목표수정', p.name || p.id.slice(0, 8));
      return { updated: true };
    }
  }
  throw new Error('목표를 찾을 수 없습니다');
}

// ============================================================
// 가족 구성원
// ============================================================
function getMembers() {
  const cached = cacheGet('members');
  if (cached) return cached;
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.MEMBERS);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const result = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues()
    .filter(r => r[0])
    .map(r => ({ name: r[0], role: r[1], color: r[2], emoji: r[3] }));
  cacheSet('members', result);
  return result;
}

function addMember(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.MEMBERS);
  if (!sheet) throw new Error('구성원 시트 없음');
  if (!p.name) throw new Error('이름은 필수입니다');
  const COLORS = ['#4f8ef7','#f87171','#34d399','#fbbf24','#a78bfa','#fb923c'];
  const EMOJIS = ['👨','👩','👧','👦','👴','👵'];
  const idx    = Math.max(sheet.getLastRow() - 1, 0);
  const lr     = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(lr + 1, 1, 1, 4).setValues([[
    p.name, p.role || '가족',
    p.color || COLORS[idx % COLORS.length],
    p.emoji || EMOJIS[idx % EMOJIS.length],
  ]]);
  logActivity(ss, '시스템', '구성원추가', p.name);
  cacheDel('members', 'dashboard');
  return { added: true };
}

// ============================================================
// 활동 로그
// ============================================================
function getActivity(limit) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.LOG);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const cnt  = Math.min(sheet.getLastRow() - 1, 200);
  const rows = sheet.getRange(sheet.getLastRow() - cnt + 1, 1, cnt, 4).getValues();
  return rows
    .filter(r => r[0])
    .map(r => ({ time: new Date(r[0]).toISOString(), member: r[1], action: r[2], detail: r[3] }))
    .reverse()
    .slice(0, limit || 50);
}

function logActivity(ss, member, action, detail) {
  const sheet = ss.getSheetByName(SH.LOG);
  if (!sheet) return;
  const lr = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(lr + 1, 1, 1, 4).setValues([[
    new Date().toISOString(), member || '미지정', action, detail || '',
  ]]);
  if (sheet.getLastRow() > 1001) sheet.deleteRow(2);
}

// ============================================================
// 설정 / 예산
// ============================================================
function getBudgets(ss) {
  const sheet = ss.getSheetByName(SH.SETTINGS);
  const budgets = {};
  if (!sheet) return budgets;
  // 카테고리 필터 없이 설정 시트의 모든 예산 행을 읽음
  sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues()
    .forEach(r => {
      if (r[0] && r[0] !== '총부채' && r[0] !== '') {
        budgets[String(r[0])] = Number(r[1]) || 0;
      }
    });
  return budgets;
}

function saveSettings(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.SETTINGS);
  if (!sheet) throw new Error('설정 시트 없음');

  // 1) 기존 행 업데이트
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  const existingKeys = new Set();
  rows.forEach((r, i) => {
    if (!r[0]) return;
    existingKeys.add(String(r[0]));
    const bkey = `budget_${r[0]}`;
    if (p[bkey] !== undefined) {
      sheet.getRange(i + 1, 2).setValue(Number(p[bkey]));
    }
    if (r[0] === '총부채' && p.totalDebts !== undefined) {
      sheet.getRange(i + 1, 2).setValue(Number(p.totalDebts));
    }
  });

  // 2) 설정 시트에 없는 새 카테고리는 행 추가
  Object.keys(p).forEach(key => {
    if (!key.startsWith('budget_')) return;
    const catName = key.replace('budget_', '');
    if (!existingKeys.has(catName)) {
      const newRow = Math.max(sheet.getLastRow(), 1) + 1;
      sheet.getRange(newRow, 1, 1, 2).setValues([[catName, Number(p[key])]]);
    }
  });

  logActivity(ss, p.member || '', '설정변경', '예산 업데이트');
  return { saved: true, budgets: getBudgets(ss) };
}

// ============================================================
// 카테고리 / 결제수단 관리
// ============================================================
function getCategories() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.CATS);
  if (!sheet || sheet.getLastRow() < 2) {
    // 시트 없으면 기본값 반환
    return {
      expense: ['식비','카페','외식','교통','주유','쇼핑','구독','통신','의료','문화','교육','경조사','보험','적금','투자수익','주식','기타'].map(n=>({name:n,icon:''})),
      income:  ['급여','부업','임대','기타수입'].map(n=>({name:n,icon:''})),
    };
  }
  const rows = sheet.getRange(2, 1, sheet.getLastRow()-1, 3).getValues();
  const expense = [], income = [];
  rows.forEach(r => {
    if (!r[0]) return;
    const obj = { name: String(r[0]), icon: String(r[2]||'') };
    if (String(r[1]).trim() === '수입') income.push(obj);
    else expense.push(obj);
  });
  return { expense, income };
}

function saveCategory(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.CATS);
  if (!sheet) throw new Error('카테고리 시트 없음 — 💰 메뉴 > 초기화를 실행하세요');
  if (!p.name) throw new Error('카테고리 이름은 필수입니다');

  // 중복 확인
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues() : [];
  for (const r of rows) {
    if (String(r[0]).trim() === p.name.trim())
      throw new Error(`"${p.name}"은 이미 있는 카테고리입니다`);
  }
  const lr = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(lr+1, 1, 1, 3).setValues([[p.name.trim(), p.type||'지출', p.icon||'']]);
  logActivity(ss, p.member||'', '카테고리추가', `${p.type} ${p.name}`);
  return { added: true };
}

function deleteCategory(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.CATS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  const rows = sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === p.name.trim()) {
      sheet.deleteRow(i + 2);
      logActivity(ss, p.member||'', '카테고리삭제', p.name);
      return { deleted: true };
    }
  }
  throw new Error('카테고리를 찾을 수 없습니다');
}

function getPayMethods() {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.PAYS);
  if (!sheet || sheet.getLastRow() < 2) {
    return ['김건년 카드','고희경 카드','생활비 카드','체크카드','신용카드','현금','계좌이체','간편결제'];
  }
  return sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues()
    .filter(r => r[0]).map(r => String(r[0]));
}

function savePayMethod(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.PAYS);
  if (!sheet) throw new Error('결제수단 시트 없음');
  if (!p.name) throw new Error('결제수단 이름은 필수입니다');
  const rows = sheet.getLastRow() > 1
    ? sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues() : [];
  for (const r of rows) {
    if (String(r[0]).trim() === p.name.trim())
      throw new Error(`"${p.name}"은 이미 있는 결제수단입니다`);
  }
  const lr = Math.max(sheet.getLastRow(), 1);
  sheet.getRange(lr+1, 1, 1, 1).setValues([[p.name.trim()]]);
  logActivity(ss, p.member||'', '결제수단추가', p.name);
  return { added: true };
}

function deletePayMethod(p) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SH.PAYS);
  if (!sheet || sheet.getLastRow() < 2) throw new Error('데이터 없음');
  const rows = sheet.getRange(2, 1, sheet.getLastRow()-1, 1).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === p.name.trim()) {
      sheet.deleteRow(i + 2);
      logActivity(ss, p.member||'', '결제수단삭제', p.name);
      return { deleted: true };
    }
  }
  throw new Error('결제수단을 찾을 수 없습니다');
}

// ============================================================
// 내부 유틸
// ============================================================
function getLedgerMonth(ss) {
  const sheet = ss.getSheetByName(SH.LEDGER);
  if (!sheet || sheet.getLastRow() < 2) return { income:0, expense:0, categories:{} };
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  return getLedgerMonthFromRows(rows);
}

// rows를 이미 갖고 있을 때 재사용 (시트 재읽기 없음)
function getLedgerMonthFromRows(rows) {
  const result = { income: 0, expense: 0, categories: {} };
  const now = new Date();
  const ny = now.getFullYear(), nm = now.getMonth();
  rows.forEach(r => {
    if (!r[0]) return;
    const d = new Date(r[0]);
    if (d.getFullYear() !== ny || d.getMonth() !== nm) return;
    const amt = Number(r[4]) || 0;
    if (r[1] === '수입') { result.income += amt; }
    else {
      result.expense += amt;
      const cat = r[2] || '기타';
      result.categories[cat] = (result.categories[cat] || 0) + amt;
    }
  });
  return result;
}

function sumCol(ss, sheetName, col) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet || sheet.getLastRow() < 2) return 0;
  return sheet.getRange(2, col, sheet.getLastRow() - 1, 1).getValues()
    .reduce((s, r) => s + (Number(r[0]) || 0), 0);
}

function getSettingVal(ss, key) {
  const sheet = ss.getSheetByName(SH.SETTINGS);
  if (!sheet) return null;
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), 2).getValues();
  for (const r of rows) { if (r[0] === key) return r[1]; }
  return null;
}

function autoClassify(desc) {
  const d = desc.toLowerCase();
  for (const [cat, kws] of Object.entries(KW)) {
    for (const kw of kws) { if (d.includes(kw.toLowerCase())) return cat; }
  }
  return '';
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ============================================================
// 스프레드시트 메뉴
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('💰 WEALTHOS')
    .addItem('🚀 초기화 (최초 1회)', 'initSystem')
    .addItem('➕ 카테고리/결제수단 탭 추가', 'addCatPaySheets')
    .addItem('🔗 웹앱 URL 확인', 'showUrl')
    .addSeparator()
    .addItem('👨‍👩‍👧 구성원 추가', 'showAddMember')
    .addItem('➕ 거래 빠른 입력', 'showAddTxn')
    .addSeparator()
    .addItem('📋 이번 달 리포트', 'makeReport')
    .addToUi();
}

function initSystem() {
  const ui  = SpreadsheetApp.getUi();
  const res = ui.alert('🚀 WEALTHOS 초기화',
    '시트를 새로 생성합니다.\n계속하시겠습니까?', ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  SpreadsheetApp.getActiveSpreadsheet().toast('⏳ 초기화 중...', 'WEALTHOS', 30);

  buildSettings(ss); buildMembers(ss); buildLog(ss);
  buildAssets(ss);   buildGoals(ss);   buildLedger(ss);
  buildCats(ss);     buildPays(ss);

  ui.alert('✅ 초기화 완료',
    '이제 배포가 필요합니다:\n\n' +
    '1. 배포 → 새 배포\n' +
    '2. 유형: 웹 앱\n' +
    '3. 실행 주체: 나\n' +
    '4. 액세스: 모든 사용자 (익명 포함)\n' +
    '5. 배포 → URL을 가족과 공유!\n\n' +
    '메뉴 > 🔗 웹앱 URL 확인으로 URL을 다시 볼 수 있습니다.',
    ui.ButtonSet.OK);
}

function showUrl() {
  const ui = SpreadsheetApp.getUi();
  try {
    const url = ScriptApp.getService().getUrl();
    ui.alert('🔗 웹앱 URL',
      '아래 URL을 가족에게 공유하세요!\n\n' + url +
      '\n\n가족 모두 이 URL 하나로 접속합니다.',
      ui.ButtonSet.OK);
  } catch(e) {
    ui.alert('배포 필요',
      '배포 → 새 배포 → 웹 앱을 먼저 실행하세요.',
      ui.ButtonSet.OK);
  }
}

function showAddMember() {
  const html = HtmlService.createHtmlOutput(`
<style>*{box-sizing:border-box}body{font-family:sans-serif;padding:16px;background:#f8fafc}
label{display:block;font-size:12px;color:#64748b;margin:8px 0 3px}
input,select{width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px}
button{width:100%;margin-top:12px;padding:10px;background:#4f8ef7;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}
.ok{color:#16a34a;text-align:center;margin-top:8px;display:none}</style>
<label>이름</label><input id="n" placeholder="예: 아빠">
<label>역할</label><select id="r"><option>가족</option><option>부모</option><option>자녀</option></select>
<label>이모지</label><select id="e"><option>👨</option><option>👩</option><option>👧</option><option>👦</option><option>👴</option><option>👵</option></select>
<button onclick="add()">추가</button>
<div class="ok" id="ok">✅ 추가됐습니다!</div>
<script>
function add(){
  var name=document.getElementById('n').value.trim();
  if(!name){alert('이름을 입력하세요');return;}
  google.script.run.withSuccessHandler(function(){
    document.getElementById('ok').style.display='block';
    document.getElementById('n').value='';
  }).addMemberFromSheet({name:name,role:document.getElementById('r').value,emoji:document.getElementById('e').value});
}
</script>`).setWidth(280).setHeight(310);
  SpreadsheetApp.getUi().showModalDialog(html, '구성원 추가');
}
function addMemberFromSheet(p) { addMember(p); }

function showAddTxn() {
  const members = getMembers();
  const mOpts   = members.map(m => `<option>${m.emoji} ${m.name}</option>`).join('') || '<option>미지정</option>';
  const html = HtmlService.createHtmlOutput(`
<style>*{box-sizing:border-box}body{font-family:sans-serif;padding:14px;background:#f8fafc;font-size:13px}
label{display:block;font-size:11px;color:#64748b;margin:8px 0 3px;text-transform:uppercase}
input,select{width:100%;padding:8px;border:1px solid #e2e8f0;border-radius:6px;font-size:13px}
.row{display:flex;gap:8px}.row>div{flex:1}
.tt{display:flex;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
.tb{flex:1;padding:8px;border:none;background:#fff;cursor:pointer;font-size:13px;color:#64748b}
.tb.e{background:#fee2e2;color:#991b1b}.tb.i{background:#d1fae5;color:#065f46}
button.sv{width:100%;margin-top:12px;padding:10px;background:#4f8ef7;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer}
.ok{color:#16a34a;text-align:center;margin-top:6px;display:none}</style>
<label>누가</label><select id="who">${mOpts}</select>
<label>유형</label>
<div class="tt">
  <button class="tb e" id="be" onclick="st('지출',this)">지출</button>
  <button class="tb" id="bi" onclick="st('수입',this)">수입</button>
</div>
<input type="hidden" id="tp" value="지출">
<div class="row">
  <div><label>날짜</label><input type="date" id="dt"></div>
  <div><label>금액(원)</label><input type="number" id="am" placeholder="6400"></div>
</div>
<div class="row">
  <div><label>카테고리</label><select id="ct">
    <option>식비</option><option>카페</option><option>외식</option><option>교통</option>
    <option>쇼핑</option><option>구독</option><option>통신</option><option>의료</option>
    <option>문화</option><option>교육</option><option>보험</option><option>기타</option>
    <option>급여</option><option>부업</option><option>투자수익</option><option>기타수입</option>
  </select></div>
  <div><label>결제</label><select id="pm">
    <option>체크카드</option><option>신용카드</option><option>현금</option><option>계좌이체</option><option>간편결제</option>
  </select></div>
</div>
<label>내용/가맹점</label><input id="dc" placeholder="예: 스타벅스">
<button class="sv" onclick="save()">저장</button>
<div class="ok" id="ok">✅ 저장됐습니다!</div>
<script>
document.getElementById('dt').value=new Date().toISOString().slice(0,10);
function st(v,el){document.getElementById('tp').value=v;document.querySelectorAll('.tb').forEach(function(b){b.className='tb';});el.className='tb '+(v==='지출'?'e':'i');}
function save(){
  var d={type:document.getElementById('tp').value,date:document.getElementById('dt').value,
    amount:document.getElementById('am').value,category:document.getElementById('ct').value,
    payMethod:document.getElementById('pm').value,desc:document.getElementById('dc').value,
    member:document.getElementById('who').value.replace(/^.+ /,'')};
  if(!d.amount||!d.desc){alert('내용과 금액을 입력하세요');return;}
  google.script.run.withSuccessHandler(function(){
    document.getElementById('ok').style.display='block';
    document.getElementById('am').value='';document.getElementById('dc').value='';
    setTimeout(function(){document.getElementById('ok').style.display='none';},2000);
  }).addTxnFromSheet(d);
}
</script>`).setWidth(340).setHeight(490);
  SpreadsheetApp.getUi().showModalDialog(html, '거래 입력');
}
function addTxnFromSheet(p) { addTransaction(p); }

function makeReport() {
  const ss   = SpreadsheetApp.getActiveSpreadsheet();
  const d    = getDashboard();
  const now  = new Date();
  const lbl  = `${now.getFullYear()}년 ${now.getMonth()+1}월`;
  const name = `📋 ${lbl} 리포트`;
  let s = ss.getSheetByName(name);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(name);
  s.setTabColor('#f59e0b');

  const f = n => Math.round(n).toLocaleString();
  const H = (t, r) => {
    s.getRange(r,1,1,6).merge().setValue(t)
      .setBackground('#1e293b').setFontColor('#fff').setFontWeight('bold').setFontSize(13);
    s.setRowHeight(r, 30);
  };
  const R = (k, v, r, bg) => {
    s.getRange(r,1,1,3).merge().setValue(k).setBackground(bg||'#f8fafc');
    s.getRange(r,4,1,3).merge().setValue(v).setHorizontalAlignment('right')
      .setFontWeight('bold').setBackground(bg||'#fff');
  };

  let r = 1;
  s.getRange(r,1,1,6).merge().setValue(`WEALTHOS Family — ${lbl} 재무 리포트`)
    .setFontSize(17).setFontWeight('bold').setBackground('#0f172a')
    .setFontColor('#fff').setHorizontalAlignment('center');
  s.setRowHeight(r++, 44); r++;

  H('💰 순자산', r++);
  R('총 자산', `₩ ${f(d.totalAssets)}`, r++);
  R('총 부채', `₩ ${f(d.totalDebts)}`, r++);
  R('순 자산', `₩ ${f(d.netWorth)}`, r++, '#dbeafe'); r++;

  H('📊 이번 달', r++);
  R('수입', `₩ ${f(d.monthlyIncome)}`, r++, '#d1fae5');
  R('지출', `₩ ${f(d.monthlyExpense)}`, r++, '#fee2e2');
  R('저축', `₩ ${f(d.monthlyIncome - d.monthlyExpense)}`, r++);
  R('저축률', `${d.savingsRate}%`, r++); r++;

  H('👨‍👩‍👧 구성원별', r++);
  Object.entries(d.memberExpense || {}).forEach(([m, a]) => R(m, `₩ ${f(a)}`, r++)); r++;

  H('🏷️ 카테고리', r++);
  Object.entries(d.categories || {}).sort((a,b) => b[1]-a[1]).forEach(([c, a]) => {
    const pct = d.monthlyExpense > 0 ? Math.round(a/d.monthlyExpense*100) : 0;
    R(c, `₩ ${f(a)} (${pct}%)`, r++);
  }); r++;

  H('🎯 목표', r++);
  (d.goals || []).forEach(g => R(g.name,
    `${g.rate}% (₩${f(g.current)} / ₩${f(g.target)})`, r++,
    g.rate >= 80 ? '#d1fae5' : g.rate >= 50 ? '#eff6ff' : '#fff'));

  for (let c = 1; c <= 6; c++) s.setColumnWidth(c, 120);
  ss.setActiveSheet(s);
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ 리포트 생성 완료!', 'WEALTHOS', 3);
}

// ============================================================
// 시트 빌더
// ============================================================
function hdr(range) {
  range.setBackground('#1e293b').setFontColor('#fff')
    .setFontWeight('bold').setHorizontalAlignment('center');
}

function buildSettings(ss) {
  let s = ss.getSheetByName(SH.SETTINGS);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(SH.SETTINGS); s.setTabColor('#6b7280');
  const rows = [['총부채',0],['',''],
    ['식비',300000],['카페',100000],['외식',250000],['교통',150000],['주유',100000],
    ['쇼핑',300000],['구독',50000],['통신',80000],['의료',80000],['문화',150000],
    ['교육',300000],['경조사',100000],['보험',100000],['기타',200000]];
  s.getRange(1,1,rows.length,2).setValues(rows);
  s.setColumnWidth(1, 150); s.setColumnWidth(2, 140);
}

function buildMembers(ss) {
  let s = ss.getSheetByName(SH.MEMBERS);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(SH.MEMBERS); s.setTabColor('#4f8ef7');
  s.getRange(1,1,1,4).setValues([['이름','역할','색상','이모지']]);
  hdr(s.getRange(1,1,1,4));
  s.getRange(2,1,3,4).setValues([
    ['아빠','부모','#4f8ef7','👨'],
    ['엄마','부모','#f87171','👩'],
    ['자녀','자녀','#34d399','👧'],
  ]);
  s.setColumnWidth(1, 120); s.setColumnWidth(2, 80); s.setColumnWidth(3, 100); s.setColumnWidth(4, 80); s.setFrozenRows(1);
}

function buildLog(ss) {
  let s = ss.getSheetByName(SH.LOG);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(SH.LOG); s.setTabColor('#6b7280');
  s.getRange(1,1,1,4).setValues([['시각','구성원','액션','상세']]);
  hdr(s.getRange(1,1,1,4));
  s.setColumnWidth(1, 200); s.setColumnWidth(2, 100); s.setColumnWidth(3, 120); s.setColumnWidth(4, 300); s.setFrozenRows(1);
  logActivity(ss, '시스템', '초기화', 'WEALTHOS Family 설치 완료');
}

function buildAssets(ss) {
  let s = ss.getSheetByName(SH.ASSETS);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(SH.ASSETS); s.setTabColor('#3b82f6');
  const h = ['자산명','유형','기관','평가금액(원)','취득금액(원)','메모','ID'];
  s.getRange(1,1,1,h.length).setValues([h]); hdr(s.getRange(1,1,1,h.length));
  const data = [
    ['국민은행 통장','예금/현금','국민은행',8500000,8500000,'',Utilities.getUuid()],
    ['카카오뱅크','예금/현금','카카오뱅크',5200000,5200000,'',Utilities.getUuid()],
    ['삼성전자 주식','주식/ETF','키움증권',4800000,3500000,'100주',Utilities.getUuid()],
    ['아파트','부동산','서울 마포',320000000,280000000,'34평',Utilities.getUuid()],
  ];
  s.getRange(2,1,data.length,h.length).setValues(data);
  s.getRange(2,4,data.length,2).setNumberFormat('#,##0');
  s.setColumnWidth(1, 160); s.setColumnWidth(2, 110); s.setColumnWidth(3, 130); s.setColumnWidth(4, 140); s.setColumnWidth(5, 130); s.setColumnWidth(6, 180); s.setColumnWidth(7, 1); s.setFrozenRows(1);
}

function buildGoals(ss) {
  let s = ss.getSheetByName(SH.GOALS);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(SH.GOALS); s.setTabColor('#f59e0b');
  const h = ['목표명','유형','목표금액(원)','현재금액(원)','목표일','월저축(원)','상태','ID'];
  s.getRange(1,1,1,h.length).setValues([h]); hdr(s.getRange(1,1,1,h.length));
  const data = [
    ['내집마련','부동산',500000000,310000000,'2027-06-01',1200000,'진행중',Utilities.getUuid()],
    ['노후자금','은퇴',300000000,84000000,'2038-01-01',800000,'진행중',Utilities.getUuid()],
    ['차량구매','자동차',50000000,42000000,'2026-08-01',500000,'진행중',Utilities.getUuid()],
    ['유럽여행','여행',5000000,1200000,'2026-12-01',380000,'진행중',Utilities.getUuid()],
  ];
  s.getRange(2,1,data.length,h.length).setValues(data);
  s.getRange(2,3,data.length,4).setNumberFormat('#,##0');
  s.setColumnWidth(1, 140); s.setColumnWidth(2, 90); s.setColumnWidth(3, 140); s.setColumnWidth(4, 140); s.setColumnWidth(5, 110); s.setColumnWidth(6, 120); s.setColumnWidth(7, 70); s.setColumnWidth(8, 1); s.setFrozenRows(1);
}

function buildCats(ss) {
  let s = ss.getSheetByName(SH.CATS);
  if (s) return; // 이미 있으면 건드리지 않음 (데이터 보호)
  s = ss.insertSheet(SH.CATS); s.setTabColor('#f59e0b');
  s.getRange(1,1,1,3).setValues([['카테고리명','유형(지출/수입)','이모지']]);
  hdr(s.getRange(1,1,1,3));
  const ecats = [
    ['식비','지출','🛒'],['카페','지출','☕'],['외식','지출','🍜'],
    ['교통','지출','🚇'],['주유','지출','⛽'],['쇼핑','지출','🛍️'],
    ['구독','지출','📺'],['통신','지출','📱'],['의료','지출','💊'],
    ['문화','지출','🎬'],['교육','지출','📚'],['경조사','지출','🎁'],
    ['보험','지출','🛡️'],['적금','지출','🏦'],['투자수익','지출','📈'],
    ['주식','지출','📊'],['생필품','지출','🧴'],['공과금','지출','🏢'],
    ['의류','지출','👕'],['기부','지출','❤️'],['여행','지출','✈️'],
    ['대출상환','지출','🏦'],['기타','지출','📌'],
    ['급여','수입','💰'],['부업','수입','💼'],['임대','수입','🏠'],['기타수입','수입','💵'],
  ];
  s.getRange(2,1,ecats.length,3).setValues(ecats);
  s.setColumnWidth(1,150); s.setColumnWidth(2,120); s.setColumnWidth(3,80);
  s.setFrozenRows(1);
  // 유형 드롭다운 유효성 검사
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['지출','수입'],true).build();
  s.getRange(2,2,100,1).setDataValidation(rule);
}

function buildPays(ss) {
  let s = ss.getSheetByName(SH.PAYS);
  if (s) return; // 이미 있으면 건드리지 않음 (데이터 보호)
  s = ss.insertSheet(SH.PAYS); s.setTabColor('#8b5cf6');
  s.getRange(1,1,1,1).setValues([['결제수단명']]);
  hdr(s.getRange(1,1,1,1));
  const pays = [
    ['김건년 카드'],['고희경 카드'],['생활비 카드'],
    ['체크카드'],['신용카드'],['현금'],['계좌이체'],['간편결제'],
  ];
  s.getRange(2,1,pays.length,1).setValues(pays);
  s.setColumnWidth(1,200); s.setFrozenRows(1);
}

// 데이터가 비어있으면 기본값으로 채움 (기존 데이터 보호)
function buildCatsSafe(ss) {
  let s = ss.getSheetByName(SH.CATS);
  if (!s) {
    // 시트 자체가 없으면 새로 생성
    buildCats(ss);
    return;
  }
  // 시트는 있는데 데이터가 없거나 헤더만 있는 경우 → 기본 데이터 추가
  if (s.getLastRow() < 2) {
    s.getRange(1,1,1,3).setValues([['카테고리명','유형(지출/수입)','이모지']]);
    hdr(s.getRange(1,1,1,3));
    const ecats = [
      ['식비','지출','🛒'],['카페','지출','☕'],['외식','지출','🍜'],
      ['교통','지출','🚇'],['주유','지출','⛽'],['쇼핑','지출','🛍️'],
      ['구독','지출','📺'],['통신','지출','📱'],['의료','지출','💊'],
      ['문화','지출','🎬'],['교육','지출','📚'],['경조사','지출','🎁'],
      ['보험','지출','🛡️'],['적금','지출','🏦'],['투자수익','지출','📈'],
      ['주식','지출','📊'],['생필품','지출','🧴'],['공과금','지출','🏢'],
      ['의류','지출','👕'],['기부','지출','❤️'],['여행','지출','✈️'],
      ['대출상환','지출','🏦'],['기타','지출','📌'],
      ['급여','수입','💰'],['부업','수입','💼'],['임대','수입','🏠'],['기타수입','수입','💵'],
    ];
    s.getRange(2,1,ecats.length,3).setValues(ecats);
    s.setColumnWidth(1,150); s.setColumnWidth(2,120); s.setColumnWidth(3,80);
    s.setFrozenRows(1);
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['지출','수입'],true).build();
    s.getRange(2,2,100,1).setDataValidation(rule);
  }
}

function buildPaysSafe(ss) {
  let s = ss.getSheetByName(SH.PAYS);
  if (!s) {
    buildPays(ss);
    return;
  }
  // 시트는 있는데 데이터가 없는 경우 → 기본 데이터 추가
  if (s.getLastRow() < 2) {
    s.getRange(1,1,1,1).setValues([['결제수단명']]);
    hdr(s.getRange(1,1,1,1));
    const pays = [
      ['김건년 카드'],['고희경 카드'],['생활비 카드'],
      ['체크카드'],['신용카드'],['현금'],['계좌이체'],['간편결제'],
    ];
    s.getRange(2,1,pays.length,1).setValues(pays);
    s.setColumnWidth(1,200); s.setFrozenRows(1);
  }
}

function buildLedger(ss) {
  let s = ss.getSheetByName(SH.LEDGER);
  if (s) ss.deleteSheet(s);
  s = ss.insertSheet(SH.LEDGER); s.setTabColor('#8b5cf6');
  const h = ['날짜','유형','카테고리','내용/가맹점','금액(원)','결제수단','메모','작성자','ID','생성시각'];
  s.getRange(1,1,1,h.length).setValues([h]); hdr(s.getRange(1,1,1,h.length));

  const typeRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['수입','지출'], true).build();
  s.getRange('B2:B5000').setDataValidation(typeRule);

  const payRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(['체크카드','신용카드','현금','계좌이체','간편결제'], true).build();
  s.getRange('F2:F5000').setDataValidation(payRule);

  const now = new Date();
  const ym  = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const sample = [
    [`${ym}-01`,'수입','급여','이번 달 급여',4200000,'계좌이체','','아빠',Utilities.getUuid(),new Date().toISOString()],
    [`${ym}-03`,'지출','카페','스타벅스',6400,'신용카드','','엄마',Utilities.getUuid(),new Date().toISOString()],
    [`${ym}-05`,'지출','식비','GS25 편의점',8500,'체크카드','','아빠',Utilities.getUuid(),new Date().toISOString()],
    [`${ym}-07`,'지출','외식','가족 외식',85000,'신용카드','주말 점심','엄마',Utilities.getUuid(),new Date().toISOString()],
    [`${ym}-15`,'수입','급여','이번 달 급여',3800000,'계좌이체','','엄마',Utilities.getUuid(),new Date().toISOString()],
    [`${ym}-20`,'지출','교육','학원비',300000,'계좌이체','','아빠',Utilities.getUuid(),new Date().toISOString()],
  ];
  s.getRange(2,1,sample.length,h.length).setValues(sample);
  s.getRange(2,5,sample.length,1).setNumberFormat('#,##0');
  s.setColumnWidth(1, 110); s.setColumnWidth(2, 65); s.setColumnWidth(3, 110); s.setColumnWidth(4, 200); s.setColumnWidth(5, 120); s.setColumnWidth(6, 100); s.setColumnWidth(7, 160); s.setColumnWidth(8, 80); s.setColumnWidth(9, 1); s.setColumnWidth(10, 1); s.setFrozenRows(1);

  s.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$B2="수입"')
      .setBackground('#d1fae5').setRanges([s.getRange('A2:J5000')]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$B2="지출"')
      .setBackground('#fff1f2').setRanges([s.getRange('A2:J5000')]).build(),
  ]);
}
