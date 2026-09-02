#include <stdio.h>
#include <string.h>

/*
 * Production entrypoint for POSIX miner custody.
 *
 * The implementation is retained in an internal include so this entrypoint can
 * enforce the release-root identity contract before the session implementation
 * can emit READY or accept mutation commands. The included implementation still
 * performs the authoritative opened-descriptor dev/inode comparison.
 */
#define main miner_custody_posix_impl_main
#include "miner-custody-posix-impl.inc"
#undef main

int main(int argc, char **argv) {
  if (argc >= 2 && strcmp(argv[1], "session") == 0 && argc != 5) {
    fprintf(stderr, "miner-custody-posix: session requires root path and expected dev/inode\n");
    return 64;
  }
  return miner_custody_posix_impl_main(argc, argv);
}
