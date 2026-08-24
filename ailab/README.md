# AI Lab v0.2 (cloud)

```
ailab/
  common.py              # спільні helper'и: shell, git-дисципліна, checkpoint
  runner.py              # Build+Verify: черга з ai-lab-ішусів -> iterate -> report
  research_runner.py     # Research+Filter: сам шукає кандидатів, нічого не будує
  queue/tasks.yaml        # генерується з GitHub Issues (label: ai-lab) на кожен ран
  state/tasks.json        # стан Build; комітиться+пушиться після кожного кроку
  state/candidates.json   # стан Research: які кандидати вже спливали
  reports/<date>.md       # звіт Build
  reports/research-<date>.md  # звіт Research: кандидати + kill-test інструкції
  logs/<task-id>/         # локальні логи ітерацій Build (VM-only, не комітяться)
  ROUTINE.md              # промпт нічної Routine і її налаштування
  INBOX.md                # інбокс ідей і рішень
  demo/make_demo.sh       # фейкові Build-задачі для перевірки лупа
```

## Pipeline

```
Research -> Filter -> [СТОП, людина вирішує] -> Build -> Verify -> Report
```

Нічний ран: спершу завжди `research_runner.py` (дешево — 2 виклики claude),
потім, якщо лишився час і в черзі є підтверджена `ai-lab`-задача — `runner.py`
(Build) на решту вікна. Вони не борються за єдиний слот "або-або": Research
має свій гарантований шматок ночі, Build довантажується, якщо є що робити.

## Research + Filter (`research_runner.py`)

Шукає сам, нічого не будує. Для кожного кандидата: проблема з цитатою+url,
кількість незалежних джерел, існуючі рішення, дедлайн-подія (якщо є),
гіпотеза чому ніша може бути порожня. Заборонено: score, confidence, market
size, willingness to pay — python-лінт (`lint_forbidden`) підсвічує таке
попередженням у звіті, а не мовчки пропускає.

Filter — окремий (адверсаріальний) виклик claude, не той самий, що шукав.
Три бінарні питання; kill-test — головна умова: конкретні дії без коду за
один вечір. Модель відповідає, але python **механічно перевіряє й
перевизначає** вердикт (`killtest_mechanically_valid`) — landing page,
прототип, опитування, MVP автоматично відхиляються, навіть якщо модель
сама сказала PASS. Кандидат без валідного kill-test ніколи не проходить.

Вихід: `reports/research-<date>.md`, до 3 кандидатів (більше — відкладені на
наступний раз, не мовчки відкинуті), кожен з готовою kill-test-інструкцією.
Ти робиш kill-test руками ввечері. Виживе ідея — **сам** релейбли
відповідний GitHub issue з `ai-lab-candidate` на `ai-lab` і допиши
acceptance-блок (це вже не "заздалегідь", а після реальної валідації) —
далі це звичайна Build-задача, без жодних змін у runner.py.

Джерела пошуку: GitHub, форуми розробників, новинні/changelog ресурси.
Reddit/X: пряме читання (WebFetch) заблоковане мережевим проксі цієї VM —
працюють лише сніпети із загального WebSearch.

## Build + Verify (`runner.py`, як у v0.1)

Один ран: `python3 ailab/runner.py` з claude/* гілки (state комітиться в неї;
з main runner нічого не комітить). Порядок: preflight реєстрів (впав —
чистий стоп зі списком недоступного) -> по задачах: worktree на гілці
`claude/ai-lab-<id>` -> цикл (claude -p фікс -> коміт -> push -> acceptance)
до зеленого / max_iterations (6) / 45 хв на задачу / 60 хв на ран. Черга:
ішус з лейблом `ai-lab`, goal = заголовок, yaml-блок у тілі:

```yaml
repo: .              # . = цей репозиторій
acceptance:          # обовʼязково, всі мусять повернути exit 0
  - ./gradlew test
max_iterations: 6    # опційно
notes: ...           # опційно
protected_paths: []  # опційно: свої глоби замість дефолтних; [] вимикає
```

Захист тестів: тестові файли (дефолтні глоби) і файли з acceptance-команд
захищені механічно — їх зміни агентом відкочуються, друге порушення = FAILED.
Хвости останніх помилок кожної задачі — у `state/last-logs/<id>.log`
(комітяться, читаються вранці без VM). Рестарт FAILED/INVALID задачі:
відредагуй її ішус — наступний ран скине запис зі state і почне заново.
