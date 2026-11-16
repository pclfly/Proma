/**
 * 定时任务主区空状态（官方 0.22.0 截图 8）。
 *
 * 列表与创建按钮在分区侧栏；主区只负责解释能力与引导创建。
 */

import * as React from 'react'
import { useSetAtom } from 'jotai'
import { ArrowLeft, Bell, CalendarClock, MessageSquareText, RotateCcw, TimerReset } from 'lucide-react'
import { automationFormAtom, createEmptyDraft } from '@/atoms/automation-atoms'
import { Button } from '@/components/ui/button'

const FEATURES = [
  {
    icon: <MessageSquareText size={16} />,
    title: '用对话创建，不必手动配置',
    body: '告诉 Agent 要做什么、什么时候做。例如：“每个工作日上午 9 点检查项目进展，连续运行 5 次。”Agent 会帮你创建定时任务。',
  },
  {
    icon: <CalendarClock size={16} />,
    title: '按间隔、日期或指定次数运行',
    body: '支持固定间隔、每天、每周、每月，也可以指定时间只运行一次，或设置最多运行几次。',
  },
  {
    icon: <Bell size={16} />,
    title: '将执行结果通知到飞书',
    body: '支持在任务结束后，将结果推送到已绑定的飞书聊天，不必一直守在 Proma 前查看。',
  },
  {
    icon: <RotateCcw size={16} />,
    title: '在结果会话里，继续迭代任务',
    body: '任务结束不是终点。直接在它的会话里要求 Agent 调整后续任务，例如：“以后只报告异常，改成每两小时检查一次。”',
  },
]

export function AutomationsWelcomeView(): React.ReactElement {
  const setForm = useSetAtom(automationFormAtom)

  const createAutomation = React.useCallback((): void => {
    const draft = createEmptyDraft()
    draft.name = '定时任务 1'
    setForm({ open: true, draft })
  }, [setForm])

  return (
    <section className="flex h-full min-h-0 flex-col overflow-y-auto bg-background scrollbar-thin">
      <div className="mx-auto flex w-full max-w-3xl flex-col px-10 py-16">
        <div className="mb-6 flex size-12 items-center justify-center rounded-xl bg-foreground/[0.06]">
          <TimerReset size={24} className="text-foreground/55" />
        </div>
        <h1 className="text-[28px] font-semibold tracking-tight text-foreground">把重复的工作交给定时任务</h1>
        <p className="mt-3 max-w-2xl text-sm leading-7 text-muted-foreground">
          按你设定的时间，让 Agent 自动执行工作，并将过程和结果保存在会话里。执行时需要 Proma 保持运行，且模型与所需工具可用。
        </p>

        <div className="mt-8 space-y-6">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                {feature.icon}
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-medium text-foreground">{feature.title}</h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{feature.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-9 flex flex-col items-start gap-3">
          <Button type="button" onClick={createAutomation} className="h-10 px-4">
            与 Agent 创建定时任务
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowLeft size={13} />
            左侧任务列表已展开，选择运行会话即可查看结果。
          </span>
        </div>
      </div>
    </section>
  )
}
