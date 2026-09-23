stock5-8 / stock5-9 종목 검색 속도 + 키보드 선택 개선

GitHub에 같은 경로로 덮어쓸 파일:
1) src/components/StockSearch.jsx
2) src/App.jsx
3) src/api.js

핵심 변경
- 검색 debounce 400ms -> 90ms
- 검색 요청 priority=high
- 같은 검색어는 메모리 캐시로 즉시 표시
- 이전 검색어의 결과를 이용해 다음 글자를 입력하면 로컬 필터 결과를 먼저 즉시 표시
- ArrowDown / ArrowUp으로 결과 이동
- Enter로 선택
- Escape로 검색 목록 닫기
- 선택 중인 결과는 배경색으로 표시하고 자동 스크롤
- StockSearch를 React.memo로 분리
- 종목 팝업에서 기존 모든 종목의 시세를 한꺼번에 요청하던 동작 제거
- 종목 시세 요청은 종목당 1회, 최대 2개 동시, priority=low
- 종목이 많아도 검색 요청이 수십 개의 시세 요청 뒤에서 대기하지 않게 개선
- App 이름 및 localStorage key는 현재 URL의 stock5-8 / stock5-9를 자동 인식
- API base도 현재 URL의 stock5-8 / stock5-9를 자동 인식

서버의 분봉/차트 관련 코드는 변경하지 않습니다.
scripts/server.js도 변경하지 않습니다.

이 3개 파일은 stock5-8과 stock5-9 공용으로 사용할 수 있게 작성했습니다.
