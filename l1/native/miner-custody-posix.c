#if defined(__APPLE__) && !defined(_DARWIN_C_SOURCE)
#define _DARWIN_C_SOURCE
#endif
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_NOFOLLOW
#error "miner destination/source custody requires O_NOFOLLOW"
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif

#define MAX_SESSION_DEPTH 64
#define COPY_BUFFER_SIZE 65536

static void die(const char *what) {
  fprintf(stderr, "miner-custody-posix: %s: %s\n", what, strerror(errno));
  exit(1);
}

static void assert_directory_fd(int fd, const char *what) {
  struct stat st;
  if (fstat(fd, &st) != 0) die(what);
  if (!S_ISDIR(st.st_mode)) {
    errno = ENOTDIR;
    die(what);
  }
}

static int open_dir_nofollow(const char *path) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) die("open directory");
  assert_directory_fd(fd, "opened root is not a directory");
  return fd;
}

static int open_child_dir_nofollow(int parent_fd, const char *name) {
  int fd = openat(parent_fd, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) die("open child directory");
  assert_directory_fd(fd, "opened child is not a directory");
  return fd;
}

static void sync_directory(int fd, const char *what) {
  if (fsync(fd) != 0) die(what);
}

static void reserve_child_dir(int parent_fd, const char *name) {
  if (mkdirat(parent_fd, name, 0700) != 0) die("reserve child directory");
  sync_directory(parent_fd, "fsync parent directory after reserve");
}

static void write_all(int fd, const unsigned char *buffer, size_t len, const char *what) {
  size_t offset = 0;
  while (offset < len) {
    ssize_t wrote = write(fd, buffer + offset, len - offset);
    if (wrote < 0) {
      if (errno == EINTR) continue;
      die(what);
    }
    if (wrote == 0) {
      errno = EIO;
      die(what);
    }
    offset += (size_t)wrote;
  }
}

static void write_child_file(int parent_fd, const char *name, const char *payload) {
  int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) die("create child file");
  size_t len = strlen(payload);
  write_all(fd, (const unsigned char *)payload, len, "write child file");
  if (fsync(fd) != 0) {
    int saved = errno;
    close(fd);
    errno = saved;
    die("fsync child file");
  }
  if (close(fd) != 0) die("close child file");
  sync_directory(parent_fd, "fsync parent directory after write");
}

static long stat_mtime_nsec(const struct stat *st) {
#if defined(__APPLE__)
  return st->st_mtimespec.tv_nsec;
#else
  return st->st_mtim.tv_nsec;
#endif
}

static long stat_ctime_nsec(const struct stat *st) {
#if defined(__APPLE__)
  return st->st_ctimespec.tv_nsec;
#else
  return st->st_ctim.tv_nsec;
#endif
}

static int same_regular_file_snapshot(const struct stat *before, const struct stat *after) {
  return S_ISREG(after->st_mode)
    && before->st_dev == after->st_dev
    && before->st_ino == after->st_ino
    && before->st_size == after->st_size
    && before->st_mtime == after->st_mtime
    && stat_mtime_nsec(before) == stat_mtime_nsec(after)
    && before->st_ctime == after->st_ctime
    && stat_ctime_nsec(before) == stat_ctime_nsec(after);
}

static void copy_child_file_from_dir(int parent_fd, const char *name, int source_dir_fd, const char *source_name) {
  int source_fd = openat(source_dir_fd, source_name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (source_fd < 0) die("open retained copy source");

  struct stat source_stat;
  if (fstat(source_fd, &source_stat) != 0) {
    int saved = errno;
    close(source_fd);
    errno = saved;
    die("fstat retained copy source");
  }
  if (!S_ISREG(source_stat.st_mode)) {
    close(source_fd);
    errno = EINVAL;
    die("retained copy source is not a regular file");
  }

  int dest_fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (dest_fd < 0) {
    int saved = errno;
    close(source_fd);
    errno = saved;
    die("create copy destination");
  }

  unsigned char buffer[COPY_BUFFER_SIZE];
  for (;;) {
    ssize_t got = read(source_fd, buffer, sizeof(buffer));
    if (got < 0) {
      if (errno == EINTR) continue;
      int saved = errno;
      close(dest_fd);
      close(source_fd);
      errno = saved;
      die("read retained copy source");
    }
    if (got == 0) break;
    write_all(dest_fd, buffer, (size_t)got, "write copy destination");
  }

  struct stat completed_source_stat;
  if (fstat(source_fd, &completed_source_stat) != 0) {
    int saved = errno;
    close(dest_fd);
    close(source_fd);
    errno = saved;
    die("fstat retained copy source after read");
  }
  if (!same_regular_file_snapshot(&source_stat, &completed_source_stat)) {
    close(dest_fd);
    close(source_fd);
    errno = ESTALE;
    die("retained copy source mutated during read");
  }

  if (fchmod(dest_fd, source_stat.st_mode & 0777) != 0) {
    int saved = errno;
    close(dest_fd);
    close(source_fd);
    errno = saved;
    die("chmod copy destination");
  }
  if (fsync(dest_fd) != 0) {
    int saved = errno;
    close(dest_fd);
    close(source_fd);
    errno = saved;
    die("fsync copy destination");
  }
  if (close(dest_fd) != 0) {
    int saved = errno;
    close(source_fd);
    errno = saved;
    die("close copy destination");
  }
  if (close(source_fd) != 0) die("close retained copy source");
  sync_directory(parent_fd, "fsync parent directory after copy");
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

static void close_stack(int *fds, size_t *depth, size_t minimum) {
  while (*depth > minimum) {
    if (close(fds[*depth - 1]) != 0) die("close retained directory");
    (*depth)--;
  }
}

static void run_session(int root_fd, const struct stat *before) {
  char line[8192];
  int dest_fds[MAX_SESSION_DEPTH];
  size_t dest_depth = 1;
  int source_fds[MAX_SESSION_DEPTH];
  size_t source_depth = 0;
  dest_fds[0] = root_fd;
  puts("READY");
  fflush(stdout);

  while (fgets(line, sizeof(line), stdin) != NULL) {
    size_t len = strlen(line);
    if (len == 0 || line[len - 1] != '\n') {
      fprintf(stderr, "miner-custody-posix: oversized or unterminated session command\n");
      exit(64);
    }
    line[len - 1] = '\0';

    if (strcmp(line, "END") == 0) {
      close_stack(source_fds, &source_depth, 0);
      close_stack(dest_fds, &dest_depth, 1);
      assert_identity_unchanged(root_fd, before);
      puts("OK END");
      fflush(stdout);
      return;
    }

    if (strcmp(line, "LEAVE") == 0) {
      if (dest_depth <= 1) {
        fprintf(stderr, "miner-custody-posix: cannot leave bound release root\n");
        exit(64);
      }
      close_stack(dest_fds, &dest_depth, dest_depth - 1);
      assert_identity_unchanged(root_fd, before);
      puts("OK LEAVE");
      fflush(stdout);
      continue;
    }

    if (strcmp(line, "SOURCE_LEAVE") == 0) {
      if (source_depth <= 1) {
        fprintf(stderr, "miner-custody-posix: cannot leave retained source root\n");
        exit(64);
      }
      close_stack(source_fds, &source_depth, source_depth - 1);
      puts("OK SOURCE_LEAVE");
      fflush(stdout);
      continue;
    }

    char *first_tab = strchr(line, '\t');
    if (!first_tab) {
      fprintf(stderr, "miner-custody-posix: malformed session command\n");
      exit(64);
    }
    *first_tab = '\0';
    const char *command = line;
    char *component = first_tab + 1;

    if (strcmp(command, "SOURCE") == 0) {
      if (!*component || strchr(component, '\t') != NULL) {
        fprintf(stderr, "miner-custody-posix: invalid source root path\n");
        exit(64);
      }
      close_stack(source_fds, &source_depth, 0);
      source_fds[0] = open_dir_nofollow(component);
      source_depth = 1;
      puts("OK SOURCE");
      fflush(stdout);
      continue;
    }

    if (strcmp(command, "SOURCE_ENTER") == 0) {
      if (source_depth == 0 || !valid_component(component) || source_depth >= MAX_SESSION_DEPTH) {
        fprintf(stderr, "miner-custody-posix: invalid retained source directory transition\n");
        exit(64);
      }
      source_fds[source_depth] = open_child_dir_nofollow(source_fds[source_depth - 1], component);
      source_depth++;
      puts("OK SOURCE_ENTER");
      fflush(stdout);
      continue;
    }

    if (!valid_component(component) && strcmp(command, "WRITE") != 0 && strcmp(command, "COPYREL") != 0) {
      fprintf(stderr, "miner-custody-posix: invalid child component\n");
      exit(64);
    }

    if (strcmp(command, "RESERVE") == 0) {
      reserve_child_dir(dest_fds[dest_depth - 1], component);
      int child_fd = open_child_dir_nofollow(dest_fds[dest_depth - 1], component);
      if (close(child_fd) != 0) die("close reserved child directory");
      assert_identity_unchanged(root_fd, before);
      puts("OK RESERVE");
      fflush(stdout);
      continue;
    }

    if (strcmp(command, "ENTER") == 0) {
      if (dest_depth >= MAX_SESSION_DEPTH) {
        fprintf(stderr, "miner-custody-posix: session directory depth exceeded\n");
        exit(64);
      }
      dest_fds[dest_depth] = open_child_dir_nofollow(dest_fds[dest_depth - 1], component);
      dest_depth++;
      assert_identity_unchanged(root_fd, before);
      puts("OK ENTER");
      fflush(stdout);
      continue;
    }

    if (strcmp(command, "WRITE") == 0 || strcmp(command, "COPYREL") == 0) {
      char *second_tab = strchr(component, '\t');
      if (!second_tab) {
        fprintf(stderr, "miner-custody-posix: malformed file command\n");
        exit(64);
      }
      *second_tab = '\0';
      const char *argument = second_tab + 1;
      if (!valid_component(component)) {
        fprintf(stderr, "miner-custody-posix: invalid child component\n");
        exit(64);
      }
      if (strcmp(command, "WRITE") == 0) {
        write_child_file(dest_fds[dest_depth - 1], component, argument);
        puts("OK WRITE");
      } else {
        if (source_depth == 0 || !valid_component(argument)) {
          fprintf(stderr, "miner-custody-posix: COPYREL requires a retained source directory and one regular-file component\n");
          exit(64);
        }
        copy_child_file_from_dir(dest_fds[dest_depth - 1], component, source_fds[source_depth - 1], argument);
        puts("OK COPYREL");
      }
      assert_identity_unchanged(root_fd, before);
      fflush(stdout);
      continue;
    }

    fprintf(stderr, "miner-custody-posix: unsupported session command\n");
    exit(64);
  }

  fprintf(stderr, "miner-custody-posix: session input closed without END\n");
  exit(65);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <bind|reserve|write|hold-write|session> <root> [component] [payload]\n", argv[0]);
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

  if (strcmp(command, "session") == 0) {
    if (argc != 3) {
      fprintf(stderr, "miner-custody-posix: session accepts only a root path\n");
      close(root_fd);
      return 64;
    }
    run_session(root_fd, &before);
    if (close(root_fd) != 0) die("close bound directory");
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