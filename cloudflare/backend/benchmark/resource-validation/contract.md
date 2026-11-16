# RealWorld 병렬 기능 계약

이 계약과 수용 테스트는 구현 시작 전에 고정한다. 두 워커는 각자 허용된 파일만 수정한다.

## 게시글 워커

수정 범위는 `app/src/routes/articles.ts`다. GET `/api/articles`와 GET `/api/articles/feed`에 `sort=newest|oldest`를 지원한다. 기본값은 newest다. newest는 createdAt DESC, id DESC이고 oldest는 createdAt ASC, id ASC다. 동일 시각 레코드도 ID로 안정적으로 정렬한다.

limit는 기본 20이며 1~100의 십진 정수다. offset는 기본 0이며 0 이상의 안전한 십진 정수다. 빈 값, 음수, 소수, 지수·16진 표현, 안전한 정수 범위 초과, 허용하지 않은 sort를 422로 반환한다. articlesCount는 필터에 맞는 전체 수이며 페이지 범위 밖이면 빈 배열과 전체 수를 반환한다. 기존 tag·author·favorited 필터와 feed 인증을 유지한다.

## 댓글 워커

수정 범위는 `app/src/routes/comments.ts`다. GET `/api/articles/:slug/comments`에 limit, offset, sort를 게시글과 동일한 의미로 지원한다. 응답에는 페이지 배열 comments와 해당 게시글의 전체 댓글 수 commentsCount를 포함한다. 모든 댓글을 조회하던 기존 기본 응답은 최대 20개로 바뀐다. 존재하지 않는 게시글은 404를 반환한다. 댓글 생성·삭제의 인증·소유권 규칙은 유지한다.

## 통합

원본 package.json, package-lock.json, prisma/schema.prisma, 공통 인증·직렬화·라우팅 등록은 고정한다. 두 구현을 병합한 뒤 `node acceptance.mjs all`과 `node run-shard.mjs all`을 모두 통과해야 완료다. 검증은 새 DB에 동일한 생성 규칙으로 fixture를 넣고 수행한다. 두 워커의 수용 검사는 각각 articles 또는 comments를 인자로 받는다.
