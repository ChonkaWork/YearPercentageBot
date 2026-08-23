#!/usr/bin/env bash
# Створює два фейкові репо і queue/tasks.yaml для перевірки лупа:
#  - demo-must-fail: acceptance = /usr/bin/false, нефіксабельно -> має стати FAILED
#  - demo-must-pass: тривіальний баг у calc.py -> має стати VERIFIED
set -euo pipefail
BASE="${1:-/home/user/ailab-demo}"
AILAB_DIR="$(cd "$(dirname "$0")/.." && pwd)"

rm -rf "$BASE"
mkdir -p "$BASE/fail-repo" "$BASE/pass-repo"

cd "$BASE/fail-repo"
git init -q -b main
echo "demo repo: acceptance is unconditionally false" > README.md
git add -A && git -c user.email=ailab@local -c user.name=ailab commit -qm "init"

cd "$BASE/pass-repo"
git init -q -b main
cat > calc.py <<'EOF'
def add(a, b):
    return a - b
EOF
cat > test_calc.py <<'EOF'
import unittest
from calc import add

class TestAdd(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)
        self.assertEqual(add(-1, 1), 0)

if __name__ == "__main__":
    unittest.main()
EOF
printf '#!/usr/bin/env bash\nexec python3 -m unittest -v test_calc.py\n' > run_tests.sh
chmod +x run_tests.sh
git add -A && git -c user.email=ailab@local -c user.name=ailab commit -qm "init"

cat > "$AILAB_DIR/queue/tasks.yaml" <<EOF
- id: demo-must-fail
  repo: $BASE/fail-repo
  goal: Make the acceptance command pass (it cannot pass; this validates the FAILED path).
  acceptance:
    - /usr/bin/false
  max_iterations: 2
  model: claude-haiku-4-5-20251001

- id: demo-no-acceptance
  repo: $BASE/fail-repo
  goal: This task has no acceptance and must be marked INVALID.
  acceptance: []

- id: demo-must-pass
  repo: $BASE/pass-repo
  goal: Fix the bug in calc.py so run_tests.sh passes. Do not modify test_calc.py.
  acceptance:
    - ./run_tests.sh
  max_iterations: 3
  model: claude-haiku-4-5-20251001
EOF

echo "demo ready: $BASE, queue: $AILAB_DIR/queue/tasks.yaml"
