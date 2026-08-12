import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../ui/timeline.js";
import { TaskInvocations, type TaskInvocation } from "./task-invocations.js";

type TaskActivityEntry = {
  id: string;
  revision: number;
  eventType: string;
  createdAt: string;
};

function activityDate(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

export function TaskHistory({ activity, invocations }: { activity: TaskActivityEntry[]; invocations: TaskInvocation[] }) {
  return (
    <section data-task-history>
      <Tabs defaultValue="activity">
        <TabsList>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="invocations">Invocations</TabsTrigger>
        </TabsList>
        <TabsContent value="activity">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>{activity.length} workflow {activity.length === 1 ? "change" : "changes"}</CardDescription>
            </CardHeader>
            <CardContent>
              <div data-task-activity>
                <Timeline orientation="vertical" value={activity.length}>
                  {activity.map((entry, index) => (
                    <TimelineItem key={entry.id} step={index + 1}>
                      <TimelineHeader>
                        <TimelineSeparator />
                        <TimelineDate dateTime={entry.createdAt}>{activityDate(entry.createdAt)}</TimelineDate>
                        <TimelineTitle>{entry.eventType}</TimelineTitle>
                        <TimelineIndicator />
                      </TimelineHeader>
                      <TimelineContent>revision {entry.revision}</TimelineContent>
                    </TimelineItem>
                  ))}
                </Timeline>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="invocations">
          <Card size="sm">
            <CardHeader>
              <CardTitle>Invocations</CardTitle>
              <CardDescription>{invocations.length} agent {invocations.length === 1 ? "attempt" : "attempts"}</CardDescription>
            </CardHeader>
            <CardContent>
              <TaskInvocations invocations={invocations} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </section>
  );
}
