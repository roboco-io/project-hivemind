# dashboard

## Overview

운영자용 웹 대시보드다. 빌드 단계가 없는 정적 자산이며, `apps/control-plane/src/app.ts`의 `buildApp`이 `public/`의 파일을 그대로 제공한다.

## Subdirectories & Boundaries

- public: [./public/README.md](./public/README.md) - 브라우저 스크립트 `app.js`와 `tool-audit.js`(워커 도구 호출 기록 패널). 운영자 API를 호출해 작업·워커·실행 근거를 표시하고, 작업 등록과 승인·반려·중단 요청을 보낸다. 서버 값은 `textContent`로만 표시한다.
