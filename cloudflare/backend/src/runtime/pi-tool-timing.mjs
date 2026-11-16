// Only numeric durations and counts leave the benchmark session.
export default function piToolTiming(pi) {
  const active=new Set();
  let started=0, elapsed=0, completed=0;
  pi.on('tool_execution_start',event=>{
    if(!active.size)started=performance.now();
    active.add(event.toolCallId);
  });
  pi.on('tool_execution_end',event=>{
    if(!active.delete(event.toolCallId))return;
    completed++;
    if(!active.size)elapsed+=performance.now()-started;
  });
  pi.on('agent_end',()=>{
    if(active.size)return;
    process.stderr.write('HIVEMIND_PI_TOOL_TIMING '+JSON.stringify({toolMs:Math.round(elapsed),toolCount:completed})+'\n');
  });
}
