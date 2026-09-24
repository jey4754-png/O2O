# Codex 웹 제어용 프롬프트 — O2O Apps Script 새 버전 배포

스크립트 ID·배포 ID는 채워 두었다. 브라우저로 수동 배포할 때만 쓴다. 평소 배포는 `scripts/deploy-collector.mjs`로 한다.

---

너는 브라우저를 조작해 Google Apps Script 웹 앱을 새 버전으로 배포한다. 이 작업은 운영 서버를 바꾸므로 아래 순서와 금지 사항을 정확히 지켜라. 단계마다 무엇을 했는지 짧게 기록하고, 예상과 다른 화면이 나오면 추측해서 진행하지 말고 멈춘 뒤 화면 상태를 보고하라.

## 입력값
- 스크립트 ID: `1S6vmyQPEvYDZrW4TynXrcaZS52rI2xOxepNaD5WaOoepV5dUcNxHL_Ya`
- 배포 ID: `AKfycbxot0xyv66E-EhpdUUxlb7Cyfcg-w252jA5osC1UVgJATnaXjspRdd0guG1rptrh9eLEA`
- 새 코드 주소: https://raw.githubusercontent.com/jey4754-png/O2O/main/apps-script/Code.gs
- 로그인 계정: dev@bottlecorp.kr (이 계정으로 로그인되어 있어야 한다. 다른 계정이면 멈추고 보고)

## 절대 하지 말 것
- 코드 맨 위 두 줄(`SPREADSHEET_ID`, `INGEST_TOKEN`)의 **실제 값을 대화·보고·로그·파일 이름·다른 사이트 어디에도 적지 마라.** 편집기 안에서만 옮겨 적는다. 보고할 때는 "실제 값으로 되돌림 확인" 처럼 결과만 말한다.
- 스프레드시트 데이터, 공유 설정, 트리거, 프로젝트 설정, 다른 배포는 건드리지 마라.
- 편집기에서 함수를 직접 실행하지 마라.
- 새 배포(Deploy → New deployment)를 만들지 마라. 기존 배포 갱신만 한다.
- 권한 승인(OAuth "액세스 허용"/"Review permissions") 창이 뜨면 누르지 말고 멈춘 뒤 보고하라.

## 1. 새 코드 확인
1. 새 코드 주소를 새 탭으로 연다.
2. 본문에 아래 네 문자열이 **모두** 있는지 페이지 내 검색으로 확인한다. 하나라도 없으면 멈추고 보고한다(아직 반영 전 코드).
   - `function samePhone_`
   - `function textCell_`
   - `function collectorSpreadsheetId_`
   - `function historicCustomerOrdersForHash_`
3. 첫 줄 근처에 `const SPREADSHEET_ID = 'REPLACE_WITH_SPREADSHEET_ID';` 와 `const INGEST_TOKEN = 'REPLACE_WITH_RANDOM_TOKEN';` 가 있는지 확인한다(자리표시자가 정상).

## 2. 편집기 열기와 백업
1. https://script.google.com/home/projects/1S6vmyQPEvYDZrW4TynXrcaZS52rI2xOxepNaD5WaOoepV5dUcNxHL_Ya/edit 를 연다.
2. 왼쪽 파일 목록에서 `Code.gs` 를 연다. 읽기 전용 표시가 있거나 편집이 안 되면 멈추고 보고한다(편집자 권한 없음).
3. 현재 `Code.gs` 전체 내용을 로컬 파일로 백업한다: `~/o2o-apps-script-backup/Code-before-20260924.gs` (폴더가 없으면 만든다). 이 파일에는 실제 값이 들어 있으므로 저장소·클라우드·채팅에 올리지 않는다.
4. 맨 위 두 줄이 자리표시자(`REPLACE_WITH_…`)가 **아닌** 실제 값인지 확인한다. 자리표시자라면 운영이 이미 멈춘 상태이니 멈추고 보고한다.

## 3. 코드 교체
1. 편집기 코드 영역을 클릭하고 전체 선택 후 삭제한다.
2. 1단계에서 연 새 코드 전체를 복사해 붙여 넣는다.
3. 맨 위 두 줄의 자리표시자를 2단계 백업에 있던 **실제 값**으로 되돌린다. 따옴표와 세미콜론 형식은 그대로 둔다.
   - `const SPREADSHEET_ID = '실제값';`
   - `const INGEST_TOKEN = '실제값';`
4. 다시 확인한다: 편집기 첫 5줄 안에 `REPLACE_WITH_` 가 **없어야** 한다. 있으면 3번을 다시 한다.
5. 저장한다(Ctrl+S / Cmd+S). 상단에 문법 오류 표시가 없고 "저장됨" 상태인지 확인한다. 오류가 있으면 2단계 백업 내용으로 되돌려 저장하고 멈춘 뒤 보고한다.

## 4. 기존 배포를 새 버전으로 갱신
1. 오른쪽 위 **배포 → 배포 관리**를 연다.
2. 목록에서 배포 ID가 `AKfycbxot0xyv66E-EhpdUUxlb7Cyfcg-w252jA5osC1UVgJATnaXjspRdd0guG1rptrh9eLEA` 인 웹 앱 배포를 고른다. 없으면 멈추고 목록에 보이는 배포 이름·유형만 보고한다.
3. 연필(수정) 아이콘을 누른다. 수정할 수 없게 막혀 있으면 멈추고 보고한다.
4. 버전을 **새 버전**으로 고르고, 설명에 `2026-09-24 전화번호 조회 수정` 을 적는다.
5. "다음 사용자 인증 정보로 실행"과 "액세스 권한이 있는 사용자" 설정은 **바꾸지 않는다.** 현재 표시된 값을 그대로 기록한다.
6. **배포**를 누른다. 권한 승인 창이 뜨면 누르지 말고 멈춘다.
7. 완료 화면의 버전 번호와 웹 앱 URL을 기록한다. URL이 배포 전과 같은지 확인한다(끝이 `/exec`).

## 5. 확인
1. 웹 앱 URL(`…/exec`)을 새 탭으로 연다.
2. 화면에 `{"ok":true,"service":"UPTWOYOU collector"}` 가 보이면 정상이다. 다른 내용이면 6단계로 되돌린다.

## 6. 문제가 생기면 되돌리기
배포 → 배포 관리 → 같은 배포 → 연필 → 버전을 **배포 전에 쓰던 번호**로 고르고 → 배포. 그 뒤 5단계로 다시 확인한다.

## 7. (선택) 다음 배포 준비
https://script.google.com/home/usersettings 에서 "Google Apps Script API" 가 꺼져 있으면 켠다. 다른 설정은 건드리지 않는다.

## 보고 형식
- 로그인 계정
- 새 코드 확인(네 문자열) 결과
- 백업 파일 경로
- 두 줄 되돌림 확인(값은 적지 말 것)
- 배포 전 버전 번호 → 새 버전 번호, 배포 시각
- 실행 사용자 / 액세스 설정 표시값
- 웹 앱 URL 유지 여부와 5단계 결과
- 멈췄다면 멈춘 단계와 화면에 보인 문구
