import { route } from '@strutvane/framework'

export default [
  route.post('/reports/revenue', { name: 'reports.revenue', permission: 'report.revenue' }),
  route.get('/health'),
]
