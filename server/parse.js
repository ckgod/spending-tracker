// 카카오뱅크 / 현대카드 결제·이체 SMS 파서.
// 실제 문자 포맷이 들어오면 보정한다. 지금은 best-effort + raw 보존.

const won = (s) => {
  const m = String(s).match(/([0-9][0-9,]*)\s*원/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
};

// 거래유형: 승인/출금/입금/취소/해외
function detectType(t) {
  if (/취소/.test(t)) return '취소';
  if (/입금/.test(t)) return '입금';
  if (/출금|이체/.test(t)) return '출금';
  if (/승인/.test(t)) return '승인';
  return null;
}

// 출처: 현대카드 / 카카오뱅크(체크카드 or 계좌)
function detectSource(t) {
  if (/현대카드/.test(t)) return '현대카드';
  if (/카카오뱅크|카뱅/.test(t)) {
    return /체크|카드/.test(t) ? '카뱅체크카드' : '카뱅계좌';
  }
  return null;
}

// 잔액
function detectBalance(t) {
  const m = t.match(/잔액\s*([0-9][0-9,]*)\s*원/);
  return m ? parseInt(m[1].replace(/,/g, ''), 10) : null;
}

// 일시: MM/DD HH:MM 또는 MM.DD HH:MM
function detectOccurredAt(t) {
  const m = t.match(/(\d{1,2})[\/.](\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const [, mo, d, h, mi] = m;
  const y = new Date().getFullYear();
  return `${y}-${mo.padStart(2,'0')}-${d.padStart(2,'0')} ${h.padStart(2,'0')}:${mi}`;
}

// 가맹점/적요: 금액·잔액·일시·키워드를 제거한 뒤 가장 그럴듯한 한 덩어리.
// 포맷이 확정되면 source별로 정교화 예정.
function detectMerchant(t, amount) {
  let s = t
    .replace(/\[?Web발신\]?/gi, '')
    .replace(/\[[^\]]*\]/g, ' ')             // [카카오뱅크] 등 대괄호 제거
    .replace(/[가-힣]\*+[가-힣]*\(\d+\)/g, ' ') // 홍*동(1234) 마스킹 계좌주 제거
    .replace(/[0-9][0-9,]*\s*원/g, ' ')       // 금액/잔액 제거
    .replace(/잔액|승인|출금|입금|이체|취소|일시불|할부|체크카드|신용|누적/g, ' ')
    .replace(/\d{1,2}[\/.]\d{1,2}\s+\d{1,2}:\d{2}/g, ' ') // 일시 제거(날짜+시각)
    .replace(/\d{1,2}[\/.]\d{1,2}/g, ' ')      // 날짜만 있는 경우 제거
    .replace(/현대카드|카카오뱅크|카뱅/g, ' ')
    .replace(/[가-힣]{1,4}님/g, ' ')          // 이름님 제거
    .replace(/\s+/g, ' ')
    .trim();
  return s || null;
}

// 현대카드 전용 라인 파서. 카드가 여러 개여도 카드명만 다르고 구조는 동일하다고 가정.
//   [Web발신]
//   <카드명> 승인|취소        예: "네이버 현대카드 Ed2 승인" / "현대카드 M 승인"
//   <카드주(마스킹)>          예: 홍*동
//   N원 일시불|N개월          예: 5,330원 일시불
//   MM/DD HH:MM              예: 06/08 10:06
//   <가맹점>                 예: 쿠팡
//   누적N원                  (신용카드 누적사용액 — 통계 무관이라 미저장)
function parseHyundai(t) {
  const lines = t.split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !/^\[?\s*web발신\s*\]?$/i.test(s));
  // 카드명: 승인/취소/거절이 든 첫 줄에서 키워드 앞부분 (두 카드 구분용)
  let card = null;
  const headIdx = lines.findIndex(l => /(승인|취소|거절|해외)/.test(l));
  if (headIdx >= 0) card = lines[headIdx].replace(/(해외)?\s*(승인|취소|거절).*$/, '').trim() || null;
  // 가맹점: 일시 줄 다음, '누적/잔액' 줄이나 순수 금액 줄 전의 첫 텍스트 줄
  let merchant = null;
  const dateIdx = lines.findIndex(l => /\d{1,2}[\/.]\d{1,2}\s+\d{1,2}:\d{2}/.test(l));
  if (dateIdx >= 0) {
    const after = lines.slice(dateIdx + 1)
      .filter(l => !/(누적|잔액)/.test(l) && !/^\d[\d,]*\s*원/.test(l));
    if (after.length) merchant = after[0];
  }
  return { card, merchant };
}

export function parseSms(text) {
  const t = String(text || '').trim();
  const amount = won(t);
  const type = detectType(t);
  let source = detectSource(t);
  const balance = detectBalance(t);
  const occurredAt = detectOccurredAt(t);
  let merchant;
  if (source === '현대카드') {
    const h = parseHyundai(t);
    merchant = h.merchant || detectMerchant(t, amount);
    if (h.card) source = h.card; // 카드 구분: source를 실제 카드명으로 (예: "네이버 현대카드 Ed2")
  } else {
    merchant = detectMerchant(t, amount);
  }
  const parsedOk = !!(amount && source); // 금액+출처는 잡혔는가
  return { amount, type, source, balance, occurredAt, merchant, parsedOk };
}
