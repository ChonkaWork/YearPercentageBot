# Нічна Routine

Налаштування (claude.ai/code/routines):
- schedule: щодня 00:00 UTC (03:00 Київ), мінімальний інтервал routines — година
- модель: claude-sonnet-5
- конектори: жодного (Gmail/Calendar/Drive/Atlassian прибрані явно —
  за замовчуванням routine затягує всі підключені)
- репозиторій: ChonkaWork/YearPercentageBot (клонується з main на кожен ран)
- environment: Default (Trusted network). Ідея: прогрів залежностей у setup
  script середовища, щоб не качати їх щоран
- "Allow unrestricted branch pushes" не вмикати: пуш тільки в claude/* гілки

Промпт routine (standalone, бо кожен ран — свіжа сесія):

---
AI Lab нічний ран. Репо: ChonkaWork/YearPercentageBot.

1. `git fetch origin claude/ai-lab-build-verify-b593cf && git checkout
   claude/ai-lab-build-verify-b593cf` — гілка з runner-ом і state.
2. Збери чергу з GitHub Issues: відкриті ішуси цього репо з лейблом `ai-lab`
   (через GitHub MCP). Кожен ішус -> запис у `ailab/queue/tasks.yaml`:
   `id: issue-<номер>`, `goal:` = заголовок, решта полів з yaml-блоку в тілі
   (repo, acceptance, max_iterations, notes). Ішус без acceptance теж додай —
   runner сам позначить INVALID. Ішусів нема — коротко зафіксуй "черга
   порожня" і заверши.
3. Запусти `python3 ailab/runner.py` і дочекайся завершення. Runner сам:
   preflight реєстрів (якщо мережа недоступна — зупиниться і скаже, що саме;
   не обходь), ліміти (6 ітерацій / 45 хв на задачу, 60 хв на ран), комітить
   і пушить state у поточну claude/* гілку, роботу — в гілки claude/ai-lab-<id>.
4. Після рану прокоментуй кожен оброблений ішус: статус (VERIFIED / FAILED /
   INVALID), ітерації, гілка, коротка причина якщо не VERIFIED. Кожен
   коментар завершуй футером атрибуції Claude Code.
5. Заборонено: merge у main, push у main, PR без явного прохання в ішусі,
   дії поза цим репо, обхід мережевих обмежень.
---
