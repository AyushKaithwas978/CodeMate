import os
import tempfile
import time
import unittest

from fastapi.testclient import TestClient

from codemate_gateway import create_app


class GatewayTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        db_path = os.path.join(self.tmpdir.name, "gateway.db")
        self.client = TestClient(create_app(db_path))

    def tearDown(self) -> None:
        self.tmpdir.cleanup()

    def test_create_task_snapshot(self) -> None:
        response = self.client.post(
            "/v1/tasks",
            json={
                "goal": "create README and commit",
                "context": {"repo_path": "."},
                "max_steps": 6,
                "time_budget_sec": 120,
                "token_budget": 5000,
            },
        )
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("task", payload)
        self.assertIn("steps", payload)
        self.assertGreaterEqual(len(payload["steps"]), 1)

    def test_high_risk_waits_for_approval(self) -> None:
        response = self.client.post(
            "/v1/tasks",
            json={
                "goal": "push latest changes to remote",
                "context": {"repo_path": "."},
                "max_steps": 8,
            },
        )
        self.assertEqual(response.status_code, 200)
        task_id = response.json()["task"]["id"]

        waited = False
        for _ in range(40):
            snap = self.client.get(f"/v1/tasks/{task_id}")
            status = snap.json()["task"]["status"]
            if status == "waiting_approval":
                waited = True
                break
            if status in {"failed", "completed", "cancelled"}:
                break
            time.sleep(0.1)

        self.assertTrue(waited, "Task never reached waiting_approval for high-risk step")


if __name__ == "__main__":
    unittest.main()
