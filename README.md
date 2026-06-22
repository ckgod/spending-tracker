# spending-tracker

카드/계좌 결제 SMS를 자동 수집해 소비 패턴을 기록·분석하는 개인용 시스템.

결제 문자가 오면 **iOS 단축어**가 자동으로 서버 webhook에 전송하고, 서버가 파싱해 SQLite에 저장한다. 달력형 웹 UI에서 일별 지출/수입 확인, 카테고리·메모 관리, 더치페이 정산, 카테고리별 분석(도넛 차트)을 할 수 있다.

```
결제 SMS ──> iOS 단축어 (자동화) ──> HTTPS ──> Caddy (리버스 프록시)
                                                   │  POST /sms (토큰 인증)
                                              spending (Node)
                                                   │  parse.js (SMS 파서)
                                              SQLite (spending.db)
                                                   │
                                              웹 UI (달력 + 분석, Basic Auth)
```

서버는 Docker Compose로 **spending(Node)** + **Caddy(자동 HTTPS)** 두 컨테이너를 띄운다. 상시 구동되는 작은 클라우드 인스턴스(예: Oracle Always Free)에 올려 두면, 폰 네트워크 상태와 무관하게 결제 문자가 누락 없이 수집된다.

## 스크린샷 (모바일)

| 달력 뷰 | 거래 상세 (정산 토글) | 분석 뷰 |
|---|---|---|
| ![달력 뷰](docs/screenshot-calendar.png) | ![거래 상세](docs/screenshot-day.png) | ![분석 뷰](docs/screenshot-stats.png) |

*스크린샷은 데모 데이터입니다.*

## 특징

- **수동 입력 없음** — 결제 문자만 오면 자동 기록 (카카오뱅크 체크카드/계좌, 현대카드 검증 완료)
- **외부 서비스 0** — 오픈뱅킹·마이데이터·스크래핑 불사용. 데이터가 내 서버 밖으로 안 나감
- **자동 HTTPS** — Caddy가 Let's Encrypt 인증서를 자동 발급·갱신. 평문 노출 없음
- **인증 이중화** — webhook은 토큰, 웹 UI/조회 API는 Basic Auth
- 앱 의존성 단 2개 (express, better-sqlite3), 프론트는 vanilla JS 단일 파일

## 요구사항

- Docker + Docker Compose
- 상시 구동 서버 (작은 클라우드 인스턴스면 충분, RAM 1GB로도 동작)
- 도메인 1개 — 자동 HTTPS에 필요. 없으면 [DuckDNS](https://www.duckdns.org) 무료 서브도메인 사용
- iPhone (단축어 자동화 "바로 실행" 지원), 카드/은행 SMS 알림 활성화

## 배포 (Docker Compose)

### 1. 코드 가져오기

```bash
git clone <이 리포지토리 URL>
cd spending-tracker
```

### 2. 시크릿·데이터 디렉토리 준비

시크릿과 DB는 이미지에 굽지 않고 `data/` 볼륨으로 주입한다 (`.gitignore` 등재됨).

```bash
mkdir -p data
# webhook 토큰 (단축어가 사용)
openssl rand -hex 16 > data/.webhook_token
# 웹 UI 비밀번호 (Basic Auth)
printf '원하는비밀번호' > data/.web_password
chmod 600 data/.webhook_token data/.web_password
```

DB(`data/spending.db`)는 첫 실행 시 자동 생성되고 스키마 마이그레이션도 기동 시 자동 처리된다. 기존 서버에서 옮겨올 때는 일관 스냅샷을 떠서 복사한다:

```bash
sqlite3 old/spending.db ".backup data/spending.db"
```

### 3. 도메인 설정

```bash
cp Caddyfile.example Caddyfile
# Caddyfile 안의 도메인을 본인 것으로 변경
```

DuckDNS를 쓴다면 서브도메인이 서버 공인 IP를 가리키도록 먼저 갱신한다:

```bash
curl "https://www.duckdns.org/update?domains=<서브도메인>&token=<토큰>&ip=<서버공인IP>"
```

### 4. 방화벽 (80 / 443)

자동 HTTPS 발급(80)과 서비스(443)를 위해 인바운드 80·443을 연다. 클라우드라면 **두 군데** 모두 열어야 한다:

- 클라우드 방화벽 (예: OCI Security List / Security Group) — TCP 80, 443
- 호스트 방화벽 (해당되면)

```bash
# 예: 호스트 iptables
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
```

### 5. 기동

```bash
docker compose up -d --build
```

확인:

```bash
curl https://<도메인>/health      # {"ok":true,"count":N,...}
```

웹 UI는 컨테이너 내부에서만 8080으로 떠 있고(`expose`), 외부에는 Caddy(HTTPS)를 통해서만 노출된다. spending 컨테이너 포트를 호스트에 직접 매핑하지 않는다.

### 파이프라인 테스트 (폰 없이)

```bash
curl -X POST "https://<도메인>/sms?token=$(cat data/.webhook_token)" \
  -H 'Content-Type: application/json' \
  -d '{"text":"[Web발신]\n[카카오뱅크]\n홍*동(1234)\n06/11 12:00\n출금 4,500원\n스타벅스\n잔액 100,000원"}'
# → {"ok":true,"id":...} 이면 웹 UI 달력에 바로 나타난다
```

## iOS 단축어 설정

은행/카드사별로 자동화를 하나씩 만든다:

1. 단축어 앱 → 자동화 → 새 자동화 → **메시지**
2. 조건: 메시지에 `카카오뱅크`(또는 `현대카드` 등 발신 문자에 항상 포함되는 키워드) 포함
3. **"즉시 실행"(바로 실행)** 켜기 — 확인 없이 자동 동작
4. 동작: **URL 콘텐츠 가져오기**
   - URL: `https://<도메인>/sms?token=<webhook_token>`
   - 방식: POST, 요청 본문: JSON, `text` = (단축어 입력 → 메시지 내용)

거래 문자가 아닌 것(인증번호·광고)은 서버 파서가 알아서 무시하므로 조건을 느슨하게 잡아도 된다.

### 지원 SMS 포맷 (parse.js)

| 출처 | 형태 | 비고 |
|---|---|---|
| 카카오뱅크 체크카드/계좌 | 멀티라인 (`출금/입금/승인 N원`, 잔액 포함) | 마스킹 계좌주 자동 제거 |
| 현대카드 | `<카드명> 승인` 라인 포맷 | 카드명이 `source`로 저장돼 복수 카드 구분 |

다른 은행/카드는 `parse.js`에 파서를 추가하면 된다. 판별 규칙: **금액 + 거래유형 + 출처**가 모두 파싱돼야 저장.

## 웹 UI

`https://<도메인>` 접속 → Basic Auth (아이디는 아무거나, 비밀번호는 `.web_password`).

- **달력 뷰**: 월간 달력에 일별 지출(빨강)/수입(초록), 사이드바에 연/월별 합계
- **거래 관리**: 날짜 클릭 → 거래별 카테고리 드롭다운, 메모, 정산 토글(더치페이 시 내 실제 부담액만 통계 반영), 통계 제외 토글
- **카테고리 관리**: 추가/삭제, 고정/비정기/변동 3그룹 지정
- **분석 탭** (`?view=stat` 딥링크): 카테고리별 도넛 차트, 기간 선택·전기간 대비 증감, 고정/비정기/변동 그룹 막대, Top5 가맹점

## API

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| GET | `/health` | 없음 | 헬스체크 (건수·시각) |
| POST | `/sms` | 토큰 (`?token=` / `X-Token` 헤더 / body) | SMS 수신 webhook |
| GET | `/api/transactions?limit=` | Basic Auth | 거래 목록 (기본 500, 최대 2000) |
| PATCH | `/api/transactions/:id` | Basic Auth | memo / category / settled / my_amount / excluded 수정 |
| GET | `/api/categories` | Basic Auth | 카테고리 + 그룹 매핑 |
| POST | `/api/categories` | Basic Auth | 카테고리 추가 (`{name, grp?}`) |
| PATCH | `/api/categories/:name` | Basic Auth | 그룹 변경 (`{grp: fixed\|irregular\|variable}`) |
| DELETE | `/api/categories/:name` | Basic Auth | 카테고리 삭제 (기존 거래의 값은 유지) |

## 보안 모델 (반드시 읽을 것)

이 프로젝트는 **금융 데이터**를 다룬다.

1. **HTTPS 강제** — Caddy가 자동 인증서를 발급하고 HTTP→HTTPS로 리다이렉트한다. 토큰·비밀번호가 평문으로 흐르지 않는다.
2. **webhook 토큰 인증** — `/sms`는 `.webhook_token` 일치 시에만 저장한다.
3. **웹 UI / 조회 API는 Basic Auth** — `/`, `/api/*`는 `.web_password` 인증이 필요하다. (`/health`만 공개)
4. **시크릿은 이미지·git 밖** — `.webhook_token`, `.web_password`, `spending.db*`(거래 원문·가맹점·잔액 포함), `*.log`(SMS 원문 로깅됨)는 전부 `.gitignore` 등재. 런타임엔 `data/` 볼륨으로만 주입된다. **DB·로그에는 SMS 원문(raw)이 그대로 저장되므로 절대 공개 저장소에 올리지 말 것.**
5. **컨테이너 직접 노출 금지** — spending 컨테이너는 호스트에 포트를 매핑하지 않고(`expose`), 오직 Caddy를 통해서만 외부에 닿는다.
6. **데이터 외부 전송 없음** — 서버는 어떤 외부 API도 호출하지 않는다.

## 설정 (환경변수)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `DATA_DIR` | 코드와 같은 디렉토리 | DB·시크릿 위치. 컨테이너에선 `/data` (볼륨) |
| `BIND_ADDR` | `127.0.0.1` | 바인딩 주소. 컨테이너에선 `0.0.0.0` (외부 노출은 Caddy가 담당) |
| `PORT` | `8080` | 리스닝 포트 |

## 대안: 사설망 직접 구동 (Docker 없이)

VPN(Tailscale 등) 내부에서만 쓸 거면 Node로 직접 띄워도 된다. 이때는 HTTPS 없이 사설망 IP에 바인딩한다.

```bash
cd server && npm install
BIND_ADDR=<사설망IP> PORT=8080 node index.js
```

단, 이 경우에도 웹 UI/API는 Basic Auth(`webAuth`)로 보호된다. 사설망이라도 공유 네트워크면 인증을 끄지 말 것.

## 라이선스 / 면책

개인 용도로 작성됨. SMS 파싱 포맷은 각 금융사 알림 문구 변경 시 깨질 수 있다.
