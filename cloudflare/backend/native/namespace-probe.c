#define _GNU_SOURCE
#include <errno.h>
#include <linux/capability.h>
#include <linux/sched.h>
#include <sched.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
static bool denied(int error){return error==EPERM||error==EACCES||error==ENOSPC||error==EUSERS||error==ENOSYS;}
static bool clone_denied(unsigned long flags,int *error){
 errno=0;long pid=syscall(SYS_clone,flags|SIGCHLD,NULL,NULL,NULL,0);*error=errno;
 if(pid==0) _exit(0);
 if(pid>0){waitpid((pid_t)pid,NULL,0);return false;}
 return denied(*error);
}
int main(void){
 struct __user_cap_header_struct header={.version=_LINUX_CAPABILITY_VERSION_3,.pid=0};struct __user_cap_data_struct data[2];memset(data,0,sizeof(data));
 bool caps=syscall(SYS_capget,&header,data)==0;
 for(int i=0;i<2;i++)caps=caps&&!data[i].effective&&!data[i].permitted&&!data[i].inheritable;
 for(int i=0;i<64;i++){errno=0;int bounding=prctl(PR_CAPBSET_READ,i,0L,0L,0L);if(bounding<0&&errno==EINVAL)continue;if(bounding!=0||prctl(PR_CAP_AMBIENT,PR_CAP_AMBIENT_IS_SET,i,0L,0L)!=0)caps=false;}
 bool nnp=prctl(PR_GET_NO_NEW_PRIVS,0L,0L,0L,0L)==1;
 errno=0;int u=unshare(CLONE_NEWUSER);int eu=errno;bool ud=u<0&&denied(eu);
 int ec=0,em=0,e3=ENOSYS;bool cd=false,md=false,c3=false;
 if(ud){cd=clone_denied(CLONE_NEWUSER,&ec);md=clone_denied(CLONE_NEWUSER|CLONE_NEWNS,&em);
#ifdef SYS_clone3
 struct clone_args args={.flags=CLONE_NEWUSER,.exit_signal=SIGCHLD};errno=0;long pid=syscall(SYS_clone3,&args,sizeof(args));e3=errno;if(pid==0) _exit(0);
 if(pid>0) waitpid((pid_t)pid,NULL,0);
 c3=pid<0&&denied(e3);
#else
 c3=true;
#endif
 }
 bool pass=caps&&nnp&&getuid()==1000&&ud&&cd&&md&&c3;
 printf("{\"passed\":%s,\"uid\":%d,\"capabilitiesZero\":%s,\"noNewPrivileges\":%s,\"unshareDenied\":%s,\"unshareErrno\":%d,\"cloneUserDenied\":%s,\"cloneErrno\":%d,\"cloneUserMountDenied\":%s,\"cloneMountErrno\":%d,\"clone3Denied\":%s,\"clone3Errno\":%d}\n",pass?"true":"false",getuid(),caps?"true":"false",nnp?"true":"false",ud?"true":"false",eu,cd?"true":"false",ec,md?"true":"false",em,c3?"true":"false",e3);
 return pass?0:1;
}
