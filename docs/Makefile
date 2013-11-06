
DOCS=adapters embedding
HTML=$(addsuffix .html, $(DOCS))
MD=$(addsuffix .md, $(DOCS))


all: $(HTML)


%.html: %.md
	markdown $< > $@


clean:
	rm -f *.html
