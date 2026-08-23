# AI Lab v0.1

```
ailab/
  runner.py             # весь цикл: queue -> state -> iterate -> report
  queue/tasks.yaml      # вхідна черга (див. tasks.example.yaml)
  state/tasks.json      # стан, атомарний запис після кожного кроку (gitignored)
  logs/<task-id>/       # iterN-claude.log, iterN-acceptance.log (gitignored)
  reports/<date>.md     # підсумок рану, одна сторінка
  demo/make_demo.sh     # генерує 2 фейкові задачі для перевірки лупа
```

Один ран: `python3 ailab/runner.py` (env: `AILAB_MODEL`, `AILAB_TASK_WALL_SEC`,
`AILAB_RUN_WALL_SEC`, `AILAB_ACCEPT_TIMEOUT`). Ран іде по задачах послідовно:
валідація -> гілка `ai-lab/<id>` -> [baseline acceptance] -> цикл
(claude -p фіксить -> коміт -> acceptance) до зеленого / max_iterations /
45 хв на задачу / 4 год на ран. Стан визначає тільки exit code acceptance.
Рестарт ідемпотентний: VERIFIED/FAILED/INVALID пропускаються, IN_PROGRESS
продовжується з останнього коміту гілки. Нічний запуск: у цьому контейнері
нема cron/systemd — планування через Claude Code Routine, яка виконує ту саму
команду. Runner ніколи не робить push і не мержить у main.
