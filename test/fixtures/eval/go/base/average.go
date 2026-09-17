package stats

func Average(values []int) int {
	if len(values) == 0 { return 0 }
	total := 0
	for _, value := range values { total += value }
	return total / len(values)
}
