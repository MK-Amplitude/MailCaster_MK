import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'

export default function NotFoundPage() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4">
      <h1 className="text-6xl font-bold text-muted-foreground">404</h1>
      <p className="text-lg text-muted-foreground">페이지를 찾을 수 없습니다.</p>
      <Button onClick={() => navigate('/')}>홈으로 돌아가기</Button>
    </div>
  )
}
