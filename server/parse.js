// 카카오뱅크 / 현대카드 결제·이체 SMS 파서.
// 실제 문자 포맷이 들어오면 보정한다. 지금은 best-effort + raw 보존.

const won = (s) => {
  const str = String(s);
  // 1) 'N원' 우선 (국내 결제·이체)
  const m = str.match(/([0-9][0-9,]*)\s*원/);
  if (m) return parseInt(m[1].replace(/,/g, ''), 10);
  // 2) 해외 원화결제 'KRW N' (소수점은 버림) — '원' 표기가 없는 해외승인 포맷 대응
  const k = str.match(/KRW\s*([0-9][0-9,]*)(?:\.\d+)?/i);
  if (k) return parseInt(k[1].replace(/,/g, ''), 10);
  return null;
};

// 거래유형: 승인/출금/입금/취소/해외
function detectType(t) {
  if (/취소/.test(t)) return '취소';
  if (/입금/.test(t)) return '입금';
  if (/출금|이체/.test(t)) return '출금';
  if (/승인/.test(t)) return '승인';
  return null;
}

// 출처: 현대카드 계열 / 카카오뱅크(체크카드 or 계좌)
// 현대카드 계열에는 제휴/상품카드(예: 스마일카드)도 포함 — 문자에 '현대카드' 글자가
// 없어도 같은 현대카드 라인 포맷이라 parseHyundai 로 처리한다.
function detectSource(t) {
  if (/현대카드|스마일카드/.test(t)) return '현대카드';
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
    .replace(/[가-힣]\*+[가-힣]*(?:\(\d+\))?님?/g, ' ') // 홍*동(1234)·고*국·고*국님 마스킹 이름 제거
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

// 현대카드 계열 라인 파서. 줄 위치가 아니라 키워드/패턴으로 잡아 포맷 변형에 견디게 한다.
// 지원하는 포맷 변형:
//   (A) 일반 — 카드명/카드주/금액/일시/가맹점이 각 줄로 분리
//     [Web발신] / 네이버 현대카드 Ed2 승인 / 고*국 / 5,330원 일시불 / 06/08 10:06 / 쿠팡 / 누적N원
//   (B) 상품카드 — 카드명+승인+카드주가 한 줄, 가맹점이 일시와 같은 줄
//     [Web발신] / 스마일카드승인 고*국 / 60,140원 일시불 / 06/15 07:02 G마켓_스마일 / 누적N원
//   (C) 해외승인 — 금액이 'KRW N.00'(원 표기 없음), 가맹점 앞에 통화줄, 뒤에 '*원화결제'
//     [Web발신] / 네이버 현대카드 Ed2 해외승인 / 고*국님 / 06/14 08:50 / KRW 13,596.00 / TEMU.COM / *원화결제
// '누적N원'(신용 누적사용액)은 통계 무관이라 미저장.
const MASK_NAME = /^[가-힣]\*+[가-힣]*(?:\(\d+\))?님?$/; // 카드주 단독 줄: 고*국 / 고*국님 / 고*국(2551)
function parseHyundai(t) {
  const lines = t.split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !/^\[?\s*web발신\s*\]?$/i.test(s));
  // 카드명: 승인/취소/거절 키워드가 든 첫 줄에서 키워드(+선행 '해외')부터 뒤를 제거.
  // "스마일카드승인 고*국" → "스마일카드", "네이버 현대카드 Ed2 해외승인" → "네이버 현대카드 Ed2"
  let card = null;
  const headIdx = lines.findIndex(l => /(승인|취소|거절)/.test(l));
  if (headIdx >= 0) card = lines[headIdx].replace(/\s*(해외)?\s*(승인|취소|거절).*$/, '').trim() || null;
  // 가맹점: 일시 줄을 찾고, 같은 줄의 시각 뒤 잔여 텍스트가 있으면 그게 가맹점(포맷 B).
  // 없으면 다음 줄들 중 금액·누적·잔액·통화(KRW)·별표부가·카드주 줄을 건너뛴 첫 줄(포맷 A/C).
  let merchant = null;
  const dateRe = /(\d{1,2}[\/.]\d{1,2})\s+(\d{1,2}:\d{2})(.*)$/;
  const dateIdx = lines.findIndex(l => dateRe.test(l));
  if (dateIdx >= 0) {
    const trailing = (lines[dateIdx].match(dateRe)?.[3] || '').trim();
    if (trailing) {
      merchant = trailing;
    } else {
      merchant = lines.slice(dateIdx + 1).find(l =>
        !/(누적|잔액)/.test(l) &&
        !/^\d[\d,]*\s*원/.test(l) &&
        !/^KRW\b/i.test(l) &&
        !/^\*/.test(l) &&
        !MASK_NAME.test(l)
      ) || null;
    }
  }
  // 가맹점에 마스킹 이름이 섞여 들어온 경우 제거.
  if (merchant) merchant = merchant.replace(/[가-힣]\*+[가-힣]*(?:\(\d+\))?님?/g, '').trim() || null;
  return { card, merchant };
}

export function parseSms(text) {
  const t = String(text || '').trim();
  const amount = won(t);
  const type = detectType(t);
  let source = detectSource(t);
  const sourceKind = source; // 카드명 치환 전 원본 출처(현대카드/카뱅체크카드/카뱅계좌)
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
  // 카드사(현대카드/스마일카드)로 분류된 입금/출금 = 카드대금 정산.
  //  - 입금: 카드사측 "…입금되었습니다" 알림
  //  - 출금: 카뱅 계좌에서 카드대금 자동납부(적요에 카드명 → detectSource가 '현대카드'로 분류)
  // 개별 승인건이 이미 지출로 집계돼 있어 이 정산건까지 합산하면 이중계산 → 통계제외 대상.
  // (현대카드 '승인'=실제 지출은 type이 '승인'이라 여기 안 걸림. 카뱅계좌 일반 출금도 sourceKind가 달라 제외 안 됨.)
  const isCardSettlement = sourceKind === '현대카드' && (type === '입금' || type === '출금');
  if (isCardSettlement) merchant = type === '입금' ? '카드대금 정산(입금)' : '카드대금 정산(출금)';
  const parsedOk = !!(amount && source); // 금액+출처는 잡혔는가
  return { amount, type, source, balance, occurredAt, merchant, parsedOk, isCardSettlement };
}
