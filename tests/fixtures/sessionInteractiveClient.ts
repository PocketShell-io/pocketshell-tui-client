import { writeSync } from 'node:fs';
const { runInteractive } = await import(process.env.PSC_FIXTURE_PROCESS_MODULE!);
const script = `import os,sys,tty,termios,signal
saved=termios.tcgetattr(0)
def resize(signum,frame):
 s=os.get_terminal_size(0);os.write(1,('RESIZE:%d:%d\\n'%(s.lines,s.columns)).encode())
signal.signal(signal.SIGWINCH,resize)
try:
 tty.setraw(0);os.write(1,('CHILD_PID:%d\\n'%os.getpid()).encode());os.write(1,b'PROMPT_READY\\n');buf=b''
 while True:
  data=os.read(0,1024)
  if not data:break
  buf+=data;os.write(1,b'BYTES:'+data.hex().encode()+b'\\n')
  if buf.endswith(b'\\x02d'):os.write(1,b'DETACH_FORWARDED\\n');sys.exit(62)
finally:termios.tcsetattr(0,termios.TCSANOW,saved)
`;
const code = await runInteractive('/usr/bin/python3', ['-c', script], { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, { sessionDetach: true, timeoutMs: 8000 });
writeSync(1, `RESULT:${code}\n`);
process.stdin.pause();
