#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/audit.h>
#include <linux/capability.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#if defined(__x86_64__) && !defined(__ILP32__)
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define NATIVE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#else
#error "Namespace guard requires native x86_64 or little-endian aarch64"
#endif

#define NAMESPACE_FLAGS ((uint32_t)(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWPID | \
    CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWCGROUP))
#define DENY_SYSCALL(number, error) \
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (error))

static const char *stage = "arguments";
static void enter_stage(const char *value) { stage = value; errno = 0; }
static void fail(void) {
    const int saved_errno = errno;
    fprintf(stderr, "Hivemind namespace guard failed: stage=%s errno=%d\n", stage, saved_errno);
    exit(125);
}

static void require_process_boundary(void) {
    enter_stage("process-boundary");
    if (getuid() != 1000 || geteuid() != 1000) { errno = EPERM; fail(); }
    int nnp = prctl(PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L);
    if (nnp < 0) fail();
    if (nnp != 1) { errno = EPERM; fail(); }

    enter_stage("capabilities");
    struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
    struct __user_cap_data_struct data[2] = {{0}};
    if (syscall(SYS_capget, &header, data) != 0) fail();
    for (size_t i = 0; i < sizeof(data) / sizeof(data[0]); i++) {
        if (data[i].effective || data[i].permitted || data[i].inheritable) { errno = EPERM; fail(); }
    }
    /* Query the running kernel instead of assuming the build header's last capability. */
    for (int capability = 0; capability < 256; capability++) {
        enter_stage("bounding-capabilities");
        int bounding = prctl(PR_CAPBSET_READ, capability, 0L, 0L, 0L);
        if (bounding < 0) {
            if (errno == EINVAL && capability > 0) return;
            fail();
        }
        if (bounding != 0) { errno = EPERM; fail(); }
        enter_stage("ambient-capabilities");
        int ambient = prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_IS_SET, capability, 0L, 0L);
        if (ambient < 0) fail();
        if (ambient != 0) { errno = EPERM; fail(); }
    }
    errno = EOVERFLOW;
    fail();
}

static void install_filter(void) {
    enter_stage("seccomp-filter");
    struct sock_filter instructions[] = {
        /* Compat ABIs have different syscall tables and must never reach the allow path. */
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
        /* x32 shares AUDIT_ARCH_X86_64 but sets this bit in the syscall number. */
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000U, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        /* Kernels before 5.4 also exposed x32-only entries 512..547 without the ABI bit. */
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 512U, 0, 2),
        BPF_JUMP(BPF_JMP | BPF_JGT | BPF_K, 547U, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
        DENY_SYSCALL(SYS_unshare, EPERM),
        DENY_SYSCALL(SYS_setns, EPERM),
        DENY_SYSCALL(SYS_mount, EPERM),
        DENY_SYSCALL(SYS_umount2, EPERM),
        DENY_SYSCALL(SYS_pivot_root, EPERM),
        DENY_SYSCALL(SYS_open_tree, EPERM),
        DENY_SYSCALL(SYS_move_mount, EPERM),
        DENY_SYSCALL(SYS_fsopen, EPERM),
        DENY_SYSCALL(SYS_fsconfig, EPERM),
        DENY_SYSCALL(SYS_fsmount, EPERM),
        DENY_SYSCALL(SYS_mount_setattr, EPERM),
#ifdef SYS_chroot
        DENY_SYSCALL(SYS_chroot, EPERM),
#endif
        /* The kernel reads clone3 flags through a pointer; force libc's checked clone fallback. */
        DENY_SYSCALL(SYS_clone3, ENOSYS),
        /* Both supported native ABIs put legacy clone flags in argument zero. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_clone, 0, 3),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, NAMESPACE_FLAGS, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)
    };
    struct sock_fprog program = {
        .len = (unsigned short)(sizeof(instructions) / sizeof(instructions[0])),
        .filter = instructions
    };
    /* Existing SDK filters remain installed; this adds restrictions without namespaces or privileges. */
    if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0L, 0L) != 0) fail();
}

static void prepare_environment(void) {
    enter_stage("env");
    const char *excluded[] = {
        "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN", "CONTROL_TOKEN", "AUTH_STORAGE_KEY", "AUTH_RETURN_PRIVATE_KEY",
        "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "PROBE_TOKEN", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"
    };
    for (size_t i = 0; i < sizeof(excluded) / sizeof(excluded[0]); i++) if (unsetenv(excluded[i]) != 0) fail();
    if (setenv("HIVEMIND_NAMESPACE_GUARD", "seccomp-v1", 1) != 0) fail();
}

static void trace_filter_loaded(void) {
    const char *enabled = getenv("HIVEMIND_GUARD_TRACE");
    if (!enabled || strcmp(enabled, "1") != 0) return;
    const char *path = "/workspace/.hivemind-guard-trace.jsonl";
    const char *lock_path = "/workspace/.hivemind-guard-trace.lock";
    int lock = open(lock_path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (lock < 0) return;
    int file = -1;
    struct timespec now;
    struct tm utc;
    char date[32], line[256];
    if (clock_gettime(CLOCK_REALTIME, &now) != 0 || !gmtime_r(&now.tv_sec, &utc) ||
        strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc) == 0) goto cleanup;
    int length = snprintf(line, sizeof(line),
        "{\"stage\":\"namespace-filter-loaded\",\"timestamp\":\"%s.%03ldZ\",\"pid\":%ld,\"ppid\":%ld}\n",
        date, now.tv_nsec / 1000000L, (long)getpid(), (long)getppid());
    if (length < 1 || (size_t)length >= sizeof(line)) goto cleanup;
    file = open(path, O_CREAT | O_APPEND | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (file < 0) goto cleanup;
    struct stat info;
    if (fstat(file, &info) != 0 || !S_ISREG(info.st_mode) || (info.st_mode & 077) ||
        info.st_nlink != 1 || info.st_size < 0 || info.st_size + length > 8192) goto cleanup;
    ssize_t written = write(file, line, (size_t)length);
    if (written != (ssize_t)length) goto cleanup;
cleanup:
    if (file >= 0) (void)close(file);
    (void)close(lock);
    (void)unlink(lock_path);
}

int main(int argc, char **argv) {
    if (argc < 3 || strcmp(argv[1], "--") != 0 || !argv[2][0]) { errno = EINVAL; fail(); }
    require_process_boundary();
    install_filter();
    prepare_environment();
    trace_filter_loaded();
    enter_stage("exec");
    execvp(argv[2], &argv[2]);
    fail();
}
