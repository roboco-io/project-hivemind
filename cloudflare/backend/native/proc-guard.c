#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <linux/landlock.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

/* ABI 3 handles every filesystem right through TRUNCATE, including REFER. */
#define HANDLED_FS ((1ULL << 15) - 1)
#define READ_EXEC (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)
#define WRITE_EXEC (HANDLED_FS & ~LANDLOCK_ACCESS_FS_REFER)
#define MAX_FD_FALLBACK 1048576ULL

enum guard_stage {
    ARGUMENTS, PROCESS_BOUNDARY, KERNEL_ABI, CREATE_RULESET, PATH_RULE,
    RESTRICT, FD_CLOSE, ENVIRONMENT, EXECUTION
};
static enum guard_stage stage = ARGUMENTS;
static const char *const stage_names[] = {
    "arguments", "process-boundary", "kernel-abi", "create-ruleset", "path-rule",
    "restrict", "fd-close", "env", "exec"
};

static void enter_stage(enum guard_stage next) {
    stage = next;
    errno = 0;
}

static void fail(void) {
    const int saved_errno = errno;
    fprintf(stderr, "Hivemind filesystem guard failed: stage=%s errno=%d\n",
            stage_names[stage], saved_errno);
    exit(125);
}

static bool zero_hex(const char *value) {
    while (*value == ' ' || *value == '\t') value++;
    size_t digits = 0;
    while (*value == '0') { value++; digits++; }
    while (*value == ' ' || *value == '\t' || *value == '\r' || *value == '\n') value++;
    return digits > 0 && *value == '\0';
}

static void require_process_boundary(void) {
    if (getuid() != 1000 || geteuid() != 1000 ||
        prctl(PR_GET_NO_NEW_PRIVS, 0L, 0L, 0L, 0L) != 1) fail();
    FILE *status = fopen("/proc/self/status", "re");
    if (!status) fail();
    const char *names[] = {"CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:"};
    unsigned seen = 0, threads = 0;
    char line[1024];
    while (fgets(line, sizeof(line), status)) {
        for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
            size_t length = strlen(names[i]);
            if (strncmp(line, names[i], length) == 0) {
                if ((seen & (1U << i)) || !zero_hex(line + length)) fail();
                seen |= 1U << i;
            }
        }
        if (strncmp(line, "Threads:", 8) == 0) {
            char *start = line + 8, *end;
            errno = 0;
            unsigned long value = strtoul(start, &end, 10);
            if (errno || end == start || value != 1 || threads++) fail();
            while (*end == ' ' || *end == '\t' || *end == '\r' || *end == '\n') end++;
            if (*end != '\0') fail();
        }
    }
    if (ferror(status) || fclose(status) != 0 || seen != 31 || threads != 1) fail();
}

static void allow_path(int ruleset, const char *path, uint64_t access) {
    int parent = open(path, O_PATH | O_CLOEXEC);
    if (parent < 0) fail();
    struct stat info;
    if (fstat(parent, &info) != 0 || !S_ISDIR(info.st_mode)) fail();
    struct landlock_path_beneath_attr rule = {.allowed_access = access, .parent_fd = parent};
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0) fail();
    if (close(parent) != 0) fail();
}

static void allow_dev_null_write(int ruleset) {
    /* Redirects may write only this device; /dev remains read-only otherwise. */
    int file = open("/dev/null", O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (file < 0) fail();
    struct stat info;
    if (fstat(file, &info) != 0 || !S_ISCHR(info.st_mode) ||
        major(info.st_rdev) != 1 || minor(info.st_rdev) != 3) fail();
    struct landlock_path_beneath_attr rule = {
        .allowed_access = LANDLOCK_ACCESS_FS_WRITE_FILE,
        .parent_fd = file
    };
    if (syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule, 0) != 0) fail();
    if (close(file) != 0) fail();
}

static void close_extra_fds(rlim_t limit) {
#ifdef SYS_close_range
    if (syscall(SYS_close_range, 3U, UINT_MAX, 0U) == 0) return;
#endif
    /* No threads can create new descriptors while the bounded fallback closes them. */
    if (limit == RLIM_INFINITY || (uint64_t)limit > MAX_FD_FALLBACK) fail();
    for (int fd = 3; (rlim_t)fd < limit; fd++) {
        if (close(fd) != 0 && errno != EBADF && errno != EINTR) fail();
    }
}

static void scrub_environment(int abi) {
    const char *excluded[] = {
        "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN", "CONTROL_TOKEN", "AUTH_STORAGE_KEY", "AUTH_RETURN_PRIVATE_KEY",
        "CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "PROBE_TOKEN", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH"
    };
    for (size_t i = 0; i < sizeof(excluded) / sizeof(excluded[0]); i++) if (unsetenv(excluded[i]) != 0) fail();
    char value[32];
    if (snprintf(value, sizeof(value), "%d", abi) < 0 || setenv("HIVEMIND_FS_GUARD_ABI", value, 1) != 0) fail();
}

int main(int argc, char **argv) {
    enter_stage(ARGUMENTS);
    if (argc < 3 || strcmp(argv[1], "--") != 0 || !argv[2][0]) fail();
    enter_stage(PROCESS_BOUNDARY);
    require_process_boundary();
    enter_stage(KERNEL_ABI);
    int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 3) fail();
    enter_stage(FD_CLOSE);
    struct rlimit fd_limit;
    if (getrlimit(RLIMIT_NOFILE, &fd_limit) != 0) fail();
    enter_stage(CREATE_RULESET);
    struct landlock_ruleset_attr attributes = {.handled_access_fs = HANDLED_FS};
    int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attributes, sizeof(attributes), 0);
    if (ruleset < 0) fail();
    const char *read_only[] = {"/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/dev", "/sys", "/opt/hivemind"};
    const char *read_write[] = {"/workspace", "/tmp", "/var/tmp"};
    enter_stage(PATH_RULE);
    for (size_t i = 0; i < sizeof(read_only) / sizeof(read_only[0]); i++) allow_path(ruleset, read_only[i], READ_EXEC);
    for (size_t i = 0; i < sizeof(read_write) / sizeof(read_write[0]); i++) allow_path(ruleset, read_write[i], WRITE_EXEC);
    allow_dev_null_write(ruleset);
    enter_stage(RESTRICT);
    if (syscall(SYS_landlock_restrict_self, ruleset, 0) != 0) fail();
    enter_stage(FD_CLOSE);
    if (close(ruleset) != 0) fail();
    close_extra_fds(fd_limit.rlim_max);
    enter_stage(ENVIRONMENT);
    scrub_environment(abi);
    enter_stage(EXECUTION);
    execvp(argv[2], &argv[2]);
    fail();
}
