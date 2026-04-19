import { useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/hooks/useAuth'
import { Users, Mail, PenLine, FolderOpen, ArrowRight } from 'lucide-react'

export default function DashboardPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const name = (user?.user_metadata?.full_name as string)?.split(' ')[0] ?? '사용자'

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">안녕하세요, {name}님 👋</h1>
        <p className="text-muted-foreground mt-1">MailCaster에 오신 것을 환영합니다.</p>
      </div>

      {/* 빠른 액션 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { icon: Mail, label: '새 메일 발송', desc: '메일 작성 및 발송', to: '/campaigns/new', color: 'text-blue-500' },
          { icon: Users, label: '연락처 관리', desc: '주소록 관리', to: '/contacts', color: 'text-green-500' },
          { icon: FolderOpen, label: '그룹 관리', desc: '그룹 구성', to: '/groups', color: 'text-purple-500' },
          { icon: PenLine, label: '서명 관리', desc: '이메일 서명', to: '/signatures', color: 'text-orange-500' },
        ].map(({ icon: Icon, label, desc, to, color }) => (
          <Card
            key={to}
            className="cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => navigate(to)}
          >
            <CardContent className="p-4 flex flex-col gap-2">
              <Icon className={`w-8 h-8 ${color}`} />
              <div>
                <p className="font-semibold text-sm">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 시작 가이드 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">시작하기</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { step: '1', label: '연락처 추가 또는 CSV 가져오기', to: '/contacts' },
            { step: '2', label: '그룹 만들기 (카테고리별 분류)', to: '/groups' },
            { step: '3', label: '이메일 서명 설정', to: '/signatures' },
            { step: '4', label: '첫 번째 메일 발송 만들기', to: '/campaigns/new' },
          ].map(({ step, label, to }) => (
            <div
              key={step}
              className="flex items-center justify-between py-2 cursor-pointer hover:bg-muted/50 rounded-lg px-3 -mx-3 transition-colors"
              onClick={() => navigate(to)}
            >
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                  {step}
                </div>
                <span className="text-sm">{label}</span>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground" />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
