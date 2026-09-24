# Codex 프롬프트 — Apps Script 직접 배포 환경 설정 (1회)

아래 `---` 아래 전체를 Codex에 붙여 넣는다. 새 코드 배포는 하지 않는다. 설정과 읽기 전용 점검까지만 한다.

> 2026-09-24 수정: 처음 판에 있던 4단계 `--probe`(같은 버전 재배포)를 뺐다. 이 웹 앱은 "배포한 사용자로 실행"(`USER_DEPLOYING`)이라, dev@bottlecorp.kr 이 배포를 갱신하면 그 순간부터 운영 콜렉터가 dev 계정으로 실행된다. Google 문서: "The web app runs as the user who deployed it." dev 계정은 이 스크립트 권한을 승인한 적이 없어 운영 전체가 멈출 수 있고, dev 쪽에서는 되돌릴 수 없다. 콜렉터 반영은 `--stage`(버전만 만들기) 뒤 소유자가 버전을 고르는 방식으로 한다.

---

너는 이 Mac에서 브라우저와 터미널을 조작해, 저장소 `/Users/seungsoohan/Projects/O2O` 에서 Google Apps Script 웹 앱을 명령어로 배포할 수 있는 환경을 설정한다. **이번 작업에서 새 코드를 배포하지는 않는다.** 단계마다 한 일을 짧게 기록하고, 예상과 다른 화면·오류가 나오면 추측해서 진행하지 말고 멈춘 뒤 보고하라.

## 고정값 (비밀값 아님)
- 사용할 구글 계정: **dev@bottlecorp.kr**
- 스크립트 ID: `1S6vmyQPEvYDZrW4TynXrcaZS52rI2xOxepNaD5WaOoepV5dUcNxHL_Ya`
- 배포 ID: `AKfycbxot0xyv66E-EhpdUUxlb7Cyfcg-w252jA5osC1UVgJATnaXjspRdd0guG1rptrh9eLEA`
- 배포 도구: `npx --yes @google/clasp@3.4.1` (버전 고정, 전역 설치하지 않는다)

## 절대 하지 말 것
- `node scripts/deploy-collector.mjs` 는 `--check` 만 실행하라. `--stage`, `--deploy`, `--probe`, `--rollback` 은 실행하지 마라. (`--deploy`·`--probe`·`--rollback` 은 운영 콜렉터의 실행 계정을 dev 계정으로 바꾼다.) `clasp push`, `clasp create-version`, `clasp update-deployment`, `clasp create-deployment`(새 배포 만들기), `clasp undeploy`, `clasp delete` 를 직접 실행하지 마라.
- Apps Script 편집기에서 코드를 고치거나 함수를 실행하지 마라. 스프레드시트 데이터·공유 설정·트리거를 건드리지 마라.
- `~/.clasprc.json`(로그인 토큰)의 내용을 출력하거나 다른 곳에 복사하지 마라.
- 원격 코드 맨 위 `SPREADSHEET_ID`·`INGEST_TOKEN` 의 실제 값을 출력·기록하지 마라. (배포 스크립트는 값을 출력하지 않는다. 스크립트 출력 외에 원격 파일을 직접 열어 보지 마라.)
- dev@bottlecorp.kr 이 아닌 계정으로 로그인·승인하지 마라.

## 1. Apps Script API 켜기
1. 브라우저에서 dev@bottlecorp.kr 로 로그인되어 있는지 확인한다. 아니면 계정을 전환한다(비밀번호 입력이 필요하면 멈추고 사용자에게 로그인을 요청한다).
2. https://script.google.com/home/usersettings 를 연다.
3. "Google Apps Script API" 가 꺼져 있으면 켠다. 다른 설정은 건드리지 않는다.
4. 조직 정책으로 켤 수 없다는 문구가 나오면 멈추고 그 문구를 그대로 보고한다.

## 2. clasp 로그인
1. 터미널에서 실행한다.
   ```bash
   cd /Users/seungsoohan/Projects/O2O
   npx --yes @google/clasp@3.4.1 login
   ```
2. 브라우저에 구글 로그인·권한 화면이 뜬다. **계정이 dev@bottlecorp.kr 인지 확인한 뒤** clasp 의 권한 요청을 허용한다. (clasp 는 Google 공식 Apps Script CLI이며, 사용자가 이 설정을 요청했다.) 다른 앱의 권한 화면이면 멈추고 보고한다.
3. 터미널에 로그인 완료 메시지가 나오면 확인한다.
   ```bash
   cd /Users/seungsoohan/Projects/O2O
   npx --yes @google/clasp@3.4.1 show-authorized-user
   ```
   dev@bottlecorp.kr 로 로그인된 상태여야 한다.

## 3. 읽기 전용 점검
```bash
cd /Users/seungsoohan/Projects/O2O
node scripts/deploy-collector.mjs --check
```
정상이면 아래가 나온다. 결과를 그대로 보고한다.
- 로그인 사용자 정보
- `deployment AKfycbxot0xy… is at version N`
- `web app: executeAs USER_DEPLOYING, access ANYONE_ANONYMOUS` (값은 다를 수 있다. 그대로 보고)
- `note: updating the live deployment from this account would ...` (executeAs 가 USER_ACCESSING 이 아니면 나온다. 정상)
- `remote file Code.js(또는 Code.gs): SPREADSHEET_ID: real value present, INGEST_TOKEN: real value present`
- `code body: editor … / repo … (same 또는 differs)`
- `deployed vN body … (same as repo 또는 differs from repo)`
- `health: HTTP 200 OK (UPTWOYOU collector)`

실패하면 `failed:` 줄을 그대로 보고하고 멈춘다. 흔한 경우:
- 권한 없음(403/permission) → Apps Script 프로젝트가 dev@bottlecorp.kr 에 편집자로 공유되지 않은 것
- `deployment_not_found_for_this_account` → 배포 목록을 볼 권한이 없음
- API 비활성 → 1단계 확인

## 4. 하지 않는 것
배포 갱신 권한을 시험하지 않는다. `--probe` 는 같은 버전이라도 배포를 다시 지정하므로, 실행 계정이 dev 계정으로 바뀐다. 콜렉터 반영 방법은 별도 작업 프롬프트(`--stage` 뒤 소유자가 버전 선택)에서 다룬다.

## 보고 형식
- 1단계: API 상태 (켜짐 / 이미 켜져 있었음 / 막힘 + 문구)
- 2단계: 로그인 계정
- 3단계 출력 전체 (비밀값은 원래 출력되지 않는다)
- 멈췄다면 멈춘 단계와 화면·터미널 문구
