# synologyAutoBot

아이폰에서 토렌트 앱 없이, 텔레그램 대화창에 아래 중 하나를 보내면 Synology NAS Download Station에 등록됩니다.

- 마그넷 링크 텍스트
- `.torrent` 파일 첨부

추가로, 다운로드 완료 후 `seeding` 상태가 되면 자동으로 일시정지해서 공유를 중지할 수 있습니다.

## 준비물

- Synology NAS (Download Station 설치/활성화)
- Telegram 계정
- Telegram 봇 토큰 (BotFather로 생성)
- NAS 다운로드 전용 계정 (권장)

## 1) 텔레그램 봇 생성

1. 텔레그램에서 `@BotFather` 검색
2. `/newbot` 실행 후 봇 생성
3. 발급된 토큰 복사

## 2) 설정

```bash
cp .env.example .env
```

`.env` 값 입력:

- `TELEGRAM_BOT_TOKEN`: BotFather 토큰
- `TELEGRAM_ALLOWED_CHAT_IDS`: 허용할 채팅 ID 목록(쉼표 구분)
- `SYNOLOGY_BASE_URL`: 예) `https://nas.example.com:5001`
- `SYNOLOGY_USERNAME` / `SYNOLOGY_PASSWORD`: Download Station 권한 계정
- `SYNOLOGY_DOWNLOAD_DIR`: (선택) 저장 경로, 앞에 `/` 없이 입력
- `SYNOLOGY_ALLOW_SELF_SIGNED`: NAS 인증서가 사설 인증서면 `true`
- `AUTO_STOP_SEEDING`: 다운로드 완료 후 시딩 자동 중지 (`true` / `false`)
- `AUTO_STOP_SEEDING_INTERVAL_SEC`: 시딩 상태 점검 주기(초)
- `BOT_DEBUG`: 디버그 로그 출력 (`true` / `false`)

`TELEGRAM_ALLOWED_CHAT_IDS`는 봇 실행 후 텔레그램에서 `/id` 명령으로 확인 가능합니다.

## 3) 실행

```bash
docker-compose up -d --build
```

로그 확인:

```bash
docker-compose logs --tail=200 -f
```

## 4) 사용 방법 (아이폰)

1. 텔레그램에서 봇 대화 시작
2. 마그넷 링크 전송 또는 `.torrent` 파일 첨부
3. 봇 응답으로 등록 결과 확인
4. NAS Download Station에서 다운로드 확인

명령어:

- `/id`: 현재 채팅 ID 확인
- `/stat`: Download Station 상태 요약
- `/task`: 다운로드 진행 상황(진행중 작업 우선)
- `/help`: 사용법 보기

## 보안 권장

- NAS 관리자 계정 대신 전용 계정 사용
- `TELEGRAM_ALLOWED_CHAT_IDS` 설정으로 허용 채팅 제한
- 외부 접속 시 HTTPS 사용

## 문제 해결

- `Synology 로그인 실패`: URL/계정/비밀번호 및 Download Station 권한 확인
- `허용되지 않은 채팅`: `/id`로 chat id 확인 후 `.env`에 추가
- `토렌트 파일 등록 실패`: `BOT_DEBUG=true`로 로그 확인

## 주의

토렌트는 합법적 배포 자료에 대해서만 사용하세요.
