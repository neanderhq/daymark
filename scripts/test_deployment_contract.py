"""Keep maintained recipe examples usable without model-generated metadata.

These focused checks catch example drift; the publisher's static validator is
authoritative. Run from any directory with PyYAML 6.0.3 installed.
"""
from pathlib import Path
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]


class DeploymentExamplesTests(unittest.TestCase):
    def test_installed_app_has_complete_production_recipe(self):
        metadata = yaml.safe_load((ROOT / '.neander/compose.yaml').read_text())['x-neander']
        self.assertEqual(metadata['migration'], 'nextjs-drizzle')
        self.assertEqual(metadata['ingress']['root_probe'], '/')
        self.assertEqual(metadata['probes'], [{'path': '/api/health', 'success_status_range': '2xx'}])
        requirements = {item['name']: item for item in metadata['environment']}
        self.assertEqual(metadata['contract_version'], 2)
        self.assertEqual(metadata['managed_services'], {'web': ['auth', 'storage', 'email', 'scheduling']})
        self.assertEqual(set(requirements), {'DATABASE_URL', 'DAYMARK_APP_URL', 'DAYMARK_APP_SECRET', 'DAYMARK_REMINDER_FUNCTION_ARN'})
        self.assertTrue(all(item['required'] for item in requirements.values()))
        self.assertEqual(requirements['DATABASE_URL']['provider'], 'Neon')
        self.assertEqual(requirements['DAYMARK_APP_URL']['binding'], 'public_origin')
        self.assertEqual(requirements['DAYMARK_REMINDER_FUNCTION_ARN']['binding'], 'function_arn')
        self.assertEqual(requirements['DAYMARK_REMINDER_FUNCTION_ARN']['resource'], 'booking-reminder')
        self.assertEqual(metadata['functions']['booking-reminder']['managed_services'], ['email'])
        self.assertEqual(metadata['functions']['booking-reminder']['environment'], {'DAYMARK_APP_URL': {'binding': 'public_origin'}})
        self.assertTrue((ROOT/'lambda/booking-reminder.mjs').is_file())

    def test_retained_database_recipe_declares_complete_requirements(self):
        examples = list((ROOT / '.neander/blocks').glob('*/.neander/compose.yaml.example'))
        self.assertEqual([path.parent.parent.name for path in examples], ['drizzle'])
        for path in examples:
            with self.subTest(block=path.parent.parent.name):
                recipe = yaml.safe_load(path.read_text())
                metadata = recipe['x-neander']
                self.assertIn(metadata['migration'], ('nextjs-drizzle', 'fastapi-alembic'))
                requirements = metadata['environment']
                names = [item['name'] for item in requirements]
                self.assertEqual(len(names), len(set(names)))
                self.assertIn('DATABASE_URL', names)
                for item in requirements:
                    self.assertTrue({'service', 'name', 'required', 'source', 'provider'} <= item.keys())
                    self.assertEqual(item['service'], 'web')
                    self.assertIs(item['required'], True)
                    if item['source'] == 'provisioned':
                        if item['name'] == 'DATABASE_URL':
                            self.assertEqual(item['provider'], 'Neon')
                        else:
                            self.assertEqual(item['provider'], 'Neander')
                            self.assertEqual(item['binding'], 'public_origin')
                    else:
                        self.assertIsNone(item['provider'])
                        self.assertIn(item['source'], ('user', 'generated'))
                        if item['source'] == 'generated':
                            self.assertEqual(item['generator'], 'opaque-random')
                self.assertEqual(recipe['secrets'], {'neander_environment': {'file': '/run/neander/secrets/neander_environment'}})
                self.assertEqual(recipe['services']['web']['secrets'], ['neander_environment'])
                self.assertNotIn('environment', recipe['services']['web'])
                self.assertTrue((ROOT / recipe['services']['web']['build']['dockerfile']).is_file())



if __name__ == '__main__':
    unittest.main()
