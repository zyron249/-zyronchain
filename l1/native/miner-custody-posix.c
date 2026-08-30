#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_NOFOLLOW
#define O_NOFOLLOW 0
#endif
#ifndef O_DIRECTORY
#define O_DIRECTORY 0
#endif

static void die(const char *what) {
  fprintf(stderr, "miner-custody-posix: %s: %s\n", what, strerror(errno));
  exit(1);
}

static int open_dir_nofollow(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) die("open directory");
  return fd;
}

static int open_child_dir_nofollow(int parent_fd, const char *name) {
  int fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) die("open child directory");
  return fd;
}

static void reserve_child_dir(int parent_fd, const char *name) {
  if (mkdirat(parent_fd, name, 0700) != 0) die("reserve child directory");
}

static void write_child_file(int parent_fd, const char *name, const char *payload) {
  int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) die("create child file");
  size_t len = strlen(payload);
  ssize_t wrote = write(fd, payload, len);
  if (wrote < 0 || (size_t)wrote != len) {
    int saved = errno;
    close(fd);
    errno = saved ? saved : EIO;
    die("write child file");
  }
  if (fsync(fd) != 0) {
    int saved = errno;
    close(fd);
    errno = saved;
    die("fsync child file");
  }
  if (close(fd) != 0) die("close child file");
}

static int valid_component(const char *name) {
  if (!name || !*name) return 0;
  if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) return 0;
  return strchr(name, '/') == NULL;
}

static void assert_identity_unchanged(int fd, const struct stat *before) {
  struct stat after;
  if (fstat(fd, &after) != 0) die("fstat bound directory after operation");
  if (before->st_dev != after.st_dev || before->st_ino != after.st_ino) {
    fprintf(stderr, "miner-custody-posix: bound directory identity changed\n");
    exit(70);
  }
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <bind|reserve|write|hold-write> <root> [component] [payload]\n", argv[0]);
    return 64;
  }

  const char *command = argv[1];
  const char *root = argv[2];
  int root_fd = open_dir_nofollow(root);
  struct stat before;
  if (fstat(root_fd, &before) != 0) die("fstat bound directory");

  if (strcmp(command, "bind") == 0) {
    printf("bound dev=%llu ino=%llu\n", (unsigned long long)before.st_dev, (unsigned long long)before.st_ino);
    close(root_fd);
    return 0;
  }

  if (argc < 4 || !valid_component(argv[3])) {
    fprintf(stderr, "miner-custody-posix: invalid child component\n");
    close(root_fd);
    return 64;
  }

  if (strcmp(command, "reserve") == 0) {
    reserve_child_dir(root_fd, argv[3]);
    int child_fd = open_child_dir_nofollow(root_fd, argv[3]);
    close(child_fd);
  } else if (strcmp(command, "write") == 0 || strcmp(command, "hold-write") == 0) {
    if (argc != 5) {
      fprintf(stderr, "miner-custody-posix: write requires payload\n");
      close(root_fd);
      return 64;
    }
    if (strcmp(command, "hold-write") == 0) {
      puts("BOUND");
      fflush(stdout);
      int ch = getchar();
      if (ch == EOF) {
        fprintf(stderr, "miner-custody-posix: hold-write coordination input closed\n");
        close(root_fd);
        return 65;
      }
    }
    write_child_file(root_fd, argv[3], argv[4]);
  } else {
    fprintf(stderr, "miner-custody-posix: unsupported command\n");
    close(root_fd);
    return 64;
  }

  assert_identity_unchanged(root_fd, &before);
  if (close(root_fd) != 0) die("close bound directory");
  return 0;
}
