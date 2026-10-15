// The guest JIT workload's HotSpot part (tests/a64/linux_boot.mjs,
// A64_WORKLOAD=jit; P6.7), run as `java Hello.java` (javac in the JVM, then
// C1 and C2): a checksum that only depends on exact arithmetic
import java.util.HashMap;
import java.util.Map;

public class Hello
{
    public static void main(String[] args)
    {
        long s = 0;
        for(int i = 1; i < 5_000_000; i++) s = (s * 31 + i) % 1_000_000_007L;
        Map<Integer, Integer> m = new HashMap<>();
        for(int i = 0; i < 200_000; i++) m.merge(i % 1000, i, Integer::sum);
        long acc = 0;
        for(Map.Entry<Integer, Integer> e : m.entrySet()) acc = (acc * 131 + e.getKey() * 7L + e.getValue()) % 1_000_000_007L;
        StringBuilder sb = new StringBuilder();
        for(int i = 0; i < 20_000; i++) sb.append(Long.toHexString(i * 2654435761L & 0xFFFFFFFFL)).append(',');
        int letters = 0;
        for(int i = 0; i < sb.length(); i++) if(Character.isLetter(sb.charAt(i))) letters++;
        double f = 0;
        for(int i = 1; i < 300_000; i++) f += StrictMath.sin(i) / i;
        System.out.println("java " + s + " " + acc + " " + sb.length() + " " + letters + " " + f);
    }
}
