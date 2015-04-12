# create files to analyze the emulator with irhydra.
#
# Important links:
#  http://mrale.ph/irhydra/2/
#  http://mrale.ph/blog/2014/01/28/prerelease-irhydra2.html
#  http://mrale.ph/blog/2014/02/23/the-black-cat-of-microbenchmarks.html

EMULATOR=http://localhost/v86/

chromium \
     --incognito\
     --no-sandbox                           \
     --js-flags="--trace-hydrogen           \
                 --trace-phase=Z            \
                 --trace-deopt              \
                 --code-comments            \
                 --hydrogen-track-positions \
                 --redirect-code-traces"    \
    $EMULATOR
    

