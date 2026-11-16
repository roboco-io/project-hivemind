interface AlarmStorage {
 getAlarm():Promise<number|null>;
 setAlarm(time:number):Promise<void>;
}

// API polling must not postpone the dispatch tick. During an alarm handler,
// Durable Object storage returns null unless a new alarm has been scheduled.
export async function ensureSchedulerAlarm(storage:AlarmStorage,now=Date.now()):Promise<void>{
 const next=now+2000;
 const pending=await storage.getAlarm();
 if(pending===null||pending>next)await storage.setAlarm(next);
}
