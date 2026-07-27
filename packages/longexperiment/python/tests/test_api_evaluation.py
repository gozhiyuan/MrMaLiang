import unittest

from maliang_experiments.api_evaluation import evaluate_api_call


class ApiEvaluationTest(unittest.TestCase):
    def test_records_identity_hashes_retries_seed_and_usage(self):
        calls = []

        def invoke(prompt, seed):
            calls.append((prompt, seed))
            if len(calls) == 1:
                raise RuntimeError("transient")
            return {"output": "answer", "model_version": "2026-07-25", "token_usage": {"input": 12, "output": 4}}

        result = evaluate_api_call(provider="example", model="small-model", prompt_template="Question: {q}", seed=23, invoke=invoke)
        self.assertEqual(result.retries, 1)
        self.assertEqual(result.seed, 23)
        self.assertEqual(result.token_usage, {"input": 12, "output": 4})
        self.assertEqual(result.model_version, "2026-07-25")
        self.assertTrue(result.prompt_template_hash.startswith("sha256:"))
        self.assertTrue(result.raw_response_hash.startswith("sha256:"))


if __name__ == "__main__":
    unittest.main()
