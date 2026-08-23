# AI Lab v0.1 (cloud)

```
ailab/
  runner.py             # весь цикл: preflight -> queue -> iterate -> report
  queue/tasks.yaml      # генерується з GitHub Issues (label: ai-lab) на кожен ран
  state/tasks.json      # стан; комітиться+пушиться після кожного кроку
  reports/<date>.md     # підсумок рану; комітиться разом зі state
  logs/<task-id>/       # локальні логи ітерацій (VM-only, не комітяться)
  ROUTINE.md            # промпт нічної Routine і її налаштування
  INBOX.md              # інбокс ідей
  demo/make_demo.sh     # фейкові задачі для перевірки лупа
```

Один ран: `python3 ailab/runner.py` з claude/* гілки (state комітиться в неї;
з main runner state НЕ комітить — заборона push у main). Порядок: preflight
реєстрів (Maven Central, npm; впав — чистий стоп зі списком недоступного) ->
по задачах: worktree на гілці `claude/ai-lab-<id>` -> цикл (claude -p фікс ->
коміт -> push -> acceptance) до зеленого / max_iterations (6) / 45 хв на
задачу / 60 хв на ран. Рестарт на свіжій VM: state з гілки, задачі-worktree
з origin. Черга: ішус з лейблом `ai-lab`, goal = заголовок, yaml-блок у тілі:

```yaml
repo: .              # . = цей репозиторій
acceptance:          # обовʼязково, всі мусять повернути exit 0
  - ./gradlew test
max_iterations: 6    # опційно
notes: ...           # опційно
```
